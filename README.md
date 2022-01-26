# gh-action-ecr-sync

Github Action which syncs docker repos from dockerhub into private AWS ECR registry.

## Problem

Dockerhub has a strict ratelimiting even if you pay for a premium subscription. This can lead to issues if your infrastructure directly pulls images from Dockerhub.

AWS provides with ECR a private registry without limits and better availability. Additionally they do not charge for traffic if pull images in the same region.

Syncing dockerhub repos regularly (e.g. once per day) in your private ECR can avoid rate limit and increase the reliability of your infrastructure.

This action tries to provide a simple way of doing this.

## Prerequisites

We expect that you already created your private AWS ECR registry, the repos which you want to be synced and know how to obtain credentials to pull/push to ECR.

In addition, this action needs the `ecr:ListImages` permission on the ECR repos you want to sync.

## Caveats

This action cannot workaround the dockerhub ratelimiting completely.
Meaning that you should not execute this action often and only sync images which you really need.
Besides that we use the docker cli to pull the missing images, so to increase the ratelimit a bit you can buy a Dockerhub subscription and run `docker login` before this action.

## Usage

```yml
name: ECR Sync
on:
  schedule:
    # Run once per night at 02:00
    - cron: '0 2 * * *'

jobs:
  sync:
    name: 'ECR Sync'
    runs-on: ubuntu-latest
    steps:
      # We expect a valid `./repos.json` file in this git repository
      - name: Checkout
        uses: actions/checkout@v2
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v1
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: eu-central-1
      - name: Login to Amazon ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v1
        with:
          registries: '123456789100'
      - name: Optional Login to DockerHub
        uses: docker/login-action@v1
        with:
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}
      - name: Sync repos
        uses: visable-dev/gh-action-ecr-sync@v1
        with:
          ecr_registry: ${{ steps.login-ecr.outputs.registry }}
          repo_file: ./repos.json
          tag_limit: 50
```

## Repo file format

The repo file is used to map the repo names from dockerhub to your custom names.
It must be a valid JSON file which matches the format:
```json
{
  "<from>": "<to>"
}
```

### Example

Given `ecr_registry` as `123456789100.dkr.ecr.eu-central-1.amazonaws.com` and content of `repo_file`:
```json
{
  "renovate/ruby": "foobar/ruby",
  "nginx": "foobar/nginx"
}
```

The action reads the file and syncs the repos:
* `registry.docker.io/renovate/ruby` to `123456789100.dkr.ecr.eu-central-1.amazonaws.com/foobar/ruby`
* `registry.docker.io/library/nginx` to `123456789100.dkr.ecr.eu-central-1.amazonaws.com/foobar/nginx`

## Inputs

The following inputs must be set:

| input | description |
| ----- | ----------- |
| `ecr_registry` | ECR registry. E.g. `123456789100.dkr.ecr.eu-central-1.amazonaws.com` |
| `repo_file` | JSON file with all repos to sync. See above section for file format. |
| `tag_limit` | Limit amount of tags per repo to sync. Tags are ordered by name (Z to A). |
