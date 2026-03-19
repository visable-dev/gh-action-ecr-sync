import * as core from '@actions/core';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {ECR, paginateListImages} from '@aws-sdk/client-ecr';
import got from 'got';
import {exec, getExecOutput} from '@actions/exec';
import {DockerAPITagsResponse, ImageMap} from './interfaces';

const SKOPEO_IMAGE = 'quay.io/skopeo/stable:latest';

const inputs = {
  ecr_registry: core.getInput('ecr_registry', {required: true}),
  repo_file: core.getInput('repo_file', {required: true}),
  tag_limit: core.getInput('tag_limit', {required: true}),
};

const errorHandler: NodeJS.UncaughtExceptionListener = error => {
  core.setFailed(error);
  throw error;
};

process.on('uncaughtException', errorHandler);
process.on('unhandledRejection', errorHandler);

const rawFile = fs.readFileSync(inputs.repo_file);
const repos: Map<string, string> = JSON.parse(rawFile.toString());

let useDocker = false;

function skopeoCmd(args: string[]): {cmd: string; args: string[]} {
  if (!useDocker) {
    return {cmd: 'skopeo', args};
  }
  const authFile = path.join(os.homedir(), '.docker', 'config.json');
  return {
    cmd: 'docker',
    args: [
      'run',
      '--rm',
      '-v',
      `${authFile}:/auth.json:ro`,
      SKOPEO_IMAGE,
      ...args,
      '--authfile',
      '/auth.json',
    ],
  };
}

async function ensureSkopeo() {
  try {
    await getExecOutput('skopeo', ['--version'], {silent: true});
    core.info('skopeo is available natively.');
    return;
  } catch {
    core.info('skopeo not found on runner, using Docker container...');
  }

  await exec('docker', ['pull', SKOPEO_IMAGE], {silent: !core.isDebug()});
  useDocker = true;
  core.info(`Using skopeo via ${SKOPEO_IMAGE}.`);
}

async function fetchAllECRImages(
  client: ECR,
  repoName: string,
): Promise<ImageMap> {
  const ecrImages: ImageMap = {};

  for await (const page of paginateListImages(
    {client},
    {repositoryName: repoName},
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

async function getSourceDigest(imageRef: string): Promise<string | null> {
  try {
    const {cmd, args} = skopeoCmd(['inspect', '--raw', `docker://${imageRef}`]);
    const {stdout} = await getExecOutput(cmd, args, {silent: true});
    const hash = crypto.createHash('sha256').update(stdout).digest('hex');
    return 'sha256:' + hash;
  } catch {
    return null;
  }
}

async function run() {
  await ensureSkopeo();

  const ecr = new ECR({});
  const execOpts = {silent: !core.isDebug()};

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

    let nextUrl: string | null =
      `https://hub.docker.com/v2/repositories/${dockerhubRepo}/tags?page_size=100&ordering=last_updated`;
    do {
      const response = (await got.get(nextUrl).json()) as DockerAPITagsResponse;

      for (const tag of response.results) {
        const linuxImages = tag.images.filter(i => i.os === 'linux');
        if (linuxImages.length === 0) continue;

        currentTagCount++;

        const xOfYLabel =
          tagLimit !== null
            ? `${currentTagCount}/${tagLimit} |`
            : `${currentTagCount} |`;

        const fromRef = `docker.io/${dockerhubRepo}:${tag.name}`;
        const toRef = `${inputs.ecr_registry}/${ecrRepo}:${tag.name}`;

        if (ecrImages[tag.name]) {
          const sourceDigest = await getSourceDigest(fromRef);
          if (sourceDigest && sourceDigest === ecrImages[tag.name].digest) {
            core.info(`${xOfYLabel} ${fromRef} is in sync.`);
            if (tagLimit !== null && currentTagCount >= tagLimit) break;
            continue;
          }
          core.info(
            `${xOfYLabel} ${fromRef} has changed, re-syncing (multi-arch)...`,
          );
        } else {
          core.info(`${xOfYLabel} ${fromRef} is new, syncing (multi-arch)...`);
        }

        const {cmd, args} = skopeoCmd([
          'copy',
          '--all',
          `docker://${fromRef}`,
          `docker://${toRef}`,
        ]);
        await exec(cmd, args, execOpts);
        core.info(`${xOfYLabel} ✓ ${tag.name} synced.`);

        if (tagLimit !== null && currentTagCount >= tagLimit) {
          core.info(
            `Reached tag limit of ${tagLimit} for repo ${dockerhubRepo}. Skipping remaining.`,
          );
          break;
        }
      }

      nextUrl = response.next;
      if (tagLimit !== null && currentTagCount >= tagLimit) {
        nextUrl = null;
      }
    } while (nextUrl);

    core.endGroup();
  }
}
void run();
