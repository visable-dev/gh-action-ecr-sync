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

export {Image, ImageMap, DockerHubImage, DockerHubTag, DockerAPITagsResponse};
