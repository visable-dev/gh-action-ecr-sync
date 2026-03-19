# gh-action-ecr-sync

GitHub Action to sync Docker Hub repositories into a private AWS ECR registry with **multi-arch support**.

## Problem

Docker Hub enforces rate limits that can disrupt CI/CD pipelines and infrastructure that pulls images directly. AWS ECR provides a private registry without pull limits and free intra-region traffic.

This action syncs Docker Hub repos into ECR on a schedule, keeping your infrastructure independent of Docker Hub availability and rate limits.

## Features

- **Multi-arch support** — syncs complete manifest lists (arm64, amd64, armv7, etc.) via `skopeo copy --all`
- **Incremental sync** — compares manifest digests and only syncs changed or new tags
- **No skopeo required** — automatically uses a Docker container if skopeo is not installed on the runner
- **Tag limit** — configurable limit per repo to control how many tags are synced

## Prerequisites

- AWS ECR repositories must already exist for the images you want to sync
- IAM permissions: `ecr:ListImages`, `ecr:BatchGetImage`, `ecr:PutImage`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, `ecr:BatchCheckLayerAvailability`
- Docker must be available on the runner (for skopeo container fallback)

## Usage

```yml
name: ECR Sync
on:
  schedule:
    - cron: '15 1 * * *'
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - name: Dockerhub login
        uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-region: eu-central-1
      - name: Login to Amazon ECR
        id: ecr-login
        uses: aws-actions/amazon-ecr-login@v2
      - name: Sync repos
        uses: visable-dev/gh-action-ecr-sync@v2
        with:
          ecr_registry: ${{ steps.ecr-login.outputs.registry }}
          repo_file: ./repos.json
          tag_limit: 25
```

## Repo file format

A JSON file that maps Docker Hub repo names to ECR repo names:

```json
{
  "<dockerhub-repo>": "<ecr-repo>"
}
```

### Example

Given `ecr_registry` as `123456789100.dkr.ecr.eu-central-1.amazonaws.com` and:

```json
{
  "oryd/kratos": "oryd/kratos",
  "nginx": "foobar/nginx"
}
```

The action syncs:
- `docker.io/oryd/kratos` → `123456789100.dkr.ecr.eu-central-1.amazonaws.com/oryd/kratos`
- `docker.io/library/nginx` → `123456789100.dkr.ecr.eu-central-1.amazonaws.com/foobar/nginx`

All architectures (amd64, arm64, etc.) are synced as a manifest list.

## Inputs

| Input | Required | Description |
| ----- | -------- | ----------- |
| `ecr_registry` | Yes | ECR registry URL, e.g. `123456789100.dkr.ecr.eu-central-1.amazonaws.com` |
| `repo_file` | Yes | Path to JSON file with repo mappings (see above) |
| `tag_limit` | No | Max number of tags per repo to sync, ordered by last updated. Default: unlimited |

## Migration from v1

v2 replaces `docker pull/tag/push` with `skopeo copy --all`. Key differences:

- Images are now pushed as **manifest lists** (Image Index) instead of single-arch manifests
- Existing single-arch images in ECR are preserved but will be replaced with manifest lists on next sync
- Docker Hub login is now **required** (was optional in v1) to avoid rate limits with skopeo
- No `sudo` or package manager access required — skopeo runs via Docker container if not natively available
