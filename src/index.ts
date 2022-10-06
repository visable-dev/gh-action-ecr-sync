import * as core from '@actions/core';
import * as fs from 'fs';
import {ECR, paginateListImages} from '@aws-sdk/client-ecr';
import got from 'got';
import {exec} from '@actions/exec';
import {DockerAPITagsResponse, ImageMap} from './interfaces';

const inputs = {
  ecr_registry: core.getInput('ecr_registry', {required: true}),
  repo_file: core.getInput('repo_file', {required: true}),
  tag_limit: core.getInput('tag_limit', {required: true}),
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

async function fetchAllECRImages(
  client: ECR,
  repoName: string
): Promise<ImageMap> {
  const ecrImages: ImageMap = {};

  for await (const page of paginateListImages(
    {client},
    {repositoryName: repoName}
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
  return ecrImages;
}

async function run() {
  const ecr = new ECR({});
  const execOpts = {failOnStdErr: true, silent: !core.isDebug()};

  let tagLimit: number | null = Number.parseInt(inputs.tag_limit);
  if (Number.isNaN(tagLimit)) {
    tagLimit = null;
  }

  if (tagLimit !== null) {
    core.info(`Tags to sync are limited to ${tagLimit} per repo.`);
  }

  for (const [key, ecrRepo] of Object.entries(repos)) {
    let dockerhubRepo = key;
    if (!dockerhubRepo.includes('/')) {
      dockerhubRepo = 'library/' + dockerhubRepo;
    }
    let currentTagCount = 0;

    core.startGroup(`Syncing repo ${dockerhubRepo} to ${ecrRepo}`);

    const ecrImages = await fetchAllECRImages(ecr, ecrRepo);
    const localImageTags: string[] = [];

    let nextUrl:
      | string
      | null = `https://hub.docker.com/v2/repositories/${dockerhubRepo}/tags?page_size=100&ordering=last_updated`;
    do {
      const response = (await got.get(nextUrl).json()) as DockerAPITagsResponse;

      for (const tag of response.results) {
        const amd64linux = tag.images.filter(
          i => i.architecture === 'amd64' && i.os === 'linux'
        );
        if (amd64linux.length > 0) {
          currentTagCount++;

          let xOfYLabel = `${currentTagCount} |`;
          if (tagLimit !== null) {
            xOfYLabel = `${currentTagCount}/${tagLimit} |`;
          }

          const fromImageTag = `${dockerhubRepo}:${tag.name}`;
          const toImageTag = `${inputs.ecr_registry}/${ecrRepo}:${tag.name}`;
          if (
            ecrImages[tag.name] &&
            ecrImages[tag.name].digest === amd64linux[0].digest
          ) {
            core.info(
              `${xOfYLabel} Image ${fromImageTag} is in sync with ${toImageTag}.`
            );
          } else {
            // Tag is missing in ECR or not up-to-date, trigger sync
            core.info(
              `${xOfYLabel} Syncing image ${fromImageTag} to ${toImageTag}`
            );

            await exec('docker', ['pull', fromImageTag], execOpts);
            await exec('docker', ['tag', fromImageTag, toImageTag], execOpts);
            await exec('docker', ['push', toImageTag], execOpts);

            localImageTags.push(toImageTag, fromImageTag);
          }
        }

        if (tagLimit !== null && currentTagCount >= tagLimit) {
          core.info(
            `Reached tag limit of ${tagLimit} for repo ${dockerhubRepo}. Skipping remaining.`
          );
          break;
        }
      }

      nextUrl = response.next;
      if (tagLimit !== null && currentTagCount >= tagLimit) {
        nextUrl = null;
      }
    } while (nextUrl);

    if (localImageTags.length > 0) {
      core.info(`Deleting ${localImageTags.length} local tags`);
      try {
        core.debug(`Deleting tags: ${localImageTags.join(', ')}`);
        await exec('docker', ['image', 'rm', ...localImageTags], execOpts)
      } catch (e) {
        core.error(`Deletion of tags failed: ${e}`)
      }
    }

    core.endGroup();
  }
}
run();
