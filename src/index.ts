import * as core from '@actions/core';
import * as fs from 'fs';
import {ECR, paginateListImages} from '@aws-sdk/client-ecr';
import got from 'got';
import {exec} from '@actions/exec';

const inputs = {
  ecr_registry: core.getInput('ecr_registry', {required: true}),
  repo_file: core.getInput('repo_file', {required: true}),
};

const errorHandler: NodeJS.UncaughtExceptionListener = error => {
  core.setFailed(error);
  // eslint-disable-next-line no-process-exit
  process.exit(1);
};

process.on('uncaughtException', errorHandler);
process.on('unhandledRejection', errorHandler);

const rawFile = fs.readFileSync(inputs.repo_file);
const repos: Map<string, string> = JSON.parse(rawFile.toString());

interface Image {
  tag: string;
  digest: string;
}

interface ImageMap {
  [key: string]: Image;
}

interface DockerHubImage {
  architecture: string;
  os: string;
  digest: string;
}

interface DockerHubTag {
  name: string;
  images: DockerHubImage[];
}

interface DockerAPITagsResponse {
  next: string | null;
  results: DockerHubTag[];
}

async function run() {
  const ecr = new ECR({});
  const execOpts = {failOnStdErr: true, silent: !core.isDebug()};

  for (const [key, ecrRepo] of Object.entries(repos)) {
    let dockerhubRepo = key;
    if (!dockerhubRepo.includes('/')) {
      dockerhubRepo = 'library/' + dockerhubRepo;
    }

    core.info(`Syncing ${dockerhubRepo} to ${ecrRepo}`);

    const ecrImages: ImageMap = {};

    for await (const page of paginateListImages(
      {client: ecr},
      {repositoryName: ecrRepo}
    )) {
      if (page.imageIds) {
        for (const imageId of page.imageIds) {
          if (imageId.imageTag && imageId.imageDigest) {
            ecrImages[imageId.imageTag] = {
              digest: imageId.imageDigest,
              tag: imageId.imageTag,
            };
          }
        }
      }
    }

    const imagesTagsForCleanup = [];

    let nextUrl:
      | string
      | null = `https://hub.docker.com/v2/repositories/${dockerhubRepo}/tags?page_size=100`;
    do {
      const response = (await got.get(nextUrl).json()) as DockerAPITagsResponse;

      for (const tag of response.results) {
        const amd64linux = tag.images.filter(
          i => i.architecture === 'amd64' && i.os === 'linux'
        );
        if (amd64linux.length > 0) {
          const fromImageTag = `${dockerhubRepo}:${tag.name}`;
          const toImageTag = `${inputs.ecr_registry}/${ecrRepo}:${tag.name}`;
          if (
            ecrImages[tag.name] &&
            ecrImages[tag.name].digest === amd64linux[0].digest
          ) {
            core.info(`Image ${fromImageTag} is in sync with ${toImageTag}.`);
            continue;
          }
          // Tag is missing in ECR or not up-to-date, trigger sync
          core.info(`Syncing image ${fromImageTag} to ${toImageTag}`);

          await exec('docker', ['pull', fromImageTag], execOpts);
          await exec('docker', ['tag', fromImageTag, toImageTag], execOpts);
          await exec('docker', ['push', toImageTag], execOpts);

          imagesTagsForCleanup.push(toImageTag, fromImageTag);
        }
      }

      nextUrl = null;
      if (response.next) {
        nextUrl = response.next;
      }
    } while (nextUrl);

    const deletionExecs = imagesTagsForCleanup.map(imageTag => {
      core.debug(`Deleting ${imageTag}`);
      return exec('docker', ['image', 'rm', imageTag], execOpts);
    });
    await Promise.all(deletionExecs);
  }
}
run();
