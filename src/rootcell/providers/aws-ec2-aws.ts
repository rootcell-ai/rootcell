import {
  DescribeInstancesCommand,
  DescribeKeyPairsCommand,
  DescribeTagsCommand,
  EC2Client,
  type EC2ClientConfig,
  type DescribeInstancesCommandOutput,
} from "@aws-sdk/client-ec2";
import {
  DeleteObjectsCommand,
  GetObjectTaggingCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import {
  GetCallerIdentityCommand,
  STSClient,
  type STSClientConfig,
} from "@aws-sdk/client-sts";
import { fromIni } from "@aws-sdk/credential-providers";
import type { RootcellConfig } from "../types.ts";

export interface AwsEc2Api {
  accountId(): Promise<string>;
  instanceStatus(instanceId: string): Promise<"missing" | "running" | "stopped" | "unexpected">;
  assertTagged(resourceIds: readonly string[], requiredTags: Readonly<Record<string, string>>): Promise<void>;
  assertKeyPairsTagged(keyNames: readonly string[], requiredTags: Readonly<Record<string, string>>): Promise<void>;
  assertS3ObjectsTagged(objects: readonly AwsS3ObjectRef[], requiredTags: Readonly<Record<string, string>>): Promise<void>;
  deleteS3Prefix(bucket: string, prefix: string): Promise<void>;
}

export interface AwsS3ObjectRef {
  readonly bucket: string;
  readonly key: string;
}

export class DefaultAwsEc2Api implements AwsEc2Api {
  private readonly credentials: NonNullable<EC2ClientConfig["credentials"]>;
  private ec2: EC2Client | undefined;
  private s3: S3Client | undefined;
  private sts: STSClient | undefined;

  constructor(private readonly config: RootcellConfig) {
    const aws = this.requireAwsConfig();
    this.credentials = fromIni({ profile: aws.profile });
  }

  async accountId(): Promise<string> {
    const response = await this.stsClient().send(new GetCallerIdentityCommand({}));
    if (response.Account === undefined || response.Account.length === 0) {
      throw new Error("AWS STS GetCallerIdentity returned no account id");
    }
    return response.Account;
  }

  async instanceStatus(instanceId: string): Promise<"missing" | "running" | "stopped" | "unexpected"> {
    let response: DescribeInstancesCommandOutput;
    try {
      response = await this.ec2Client().send(new DescribeInstancesCommand({
        InstanceIds: [instanceId],
      }));
    } catch (error) {
      if (awsErrorName(error) === "InvalidInstanceID.NotFound") {
        return "missing";
      }
      throw error;
    }
    const instance = response.Reservations?.flatMap((reservation) => reservation.Instances ?? [])[0];
    const state = instance?.State?.Name;
    if (state === undefined) {
      return "missing";
    }
    if (state === "running" || state === "stopped") {
      return state;
    }
    if (state === "terminated" || state === "shutting-down") {
      return "missing";
    }
    return "unexpected";
  }

  async assertTagged(resourceIds: readonly string[], requiredTags: Readonly<Record<string, string>>): Promise<void> {
    const ids = [...new Set(resourceIds)];
    for (const id of ids) {
      const byResource = new Map<string, Map<string, string>>();
      let nextToken: string | undefined;
      do {
        const response = await this.ec2Client().send(new DescribeTagsCommand({
          Filters: [
            { Name: "resource-id", Values: [id] },
          ],
          NextToken: nextToken,
        }));
        for (const tag of response.Tags ?? []) {
          if (tag.ResourceId === undefined || tag.Key === undefined || tag.Value === undefined) {
            continue;
          }
          const tags = byResource.get(tag.ResourceId) ?? new Map<string, string>();
          tags.set(tag.Key, tag.Value);
          byResource.set(tag.ResourceId, tags);
        }
        nextToken = response.NextToken;
      } while (nextToken !== undefined);
      const tags = byResource.get(id);
      for (const [key, value] of Object.entries(requiredTags)) {
        if (tags?.get(key) !== value) {
          throw new Error(`refusing to delete AWS resource ${id}: missing required tag ${key}=${value}`);
        }
      }
    }
  }

  async assertKeyPairsTagged(keyNames: readonly string[], requiredTags: Readonly<Record<string, string>>): Promise<void> {
    for (const keyName of [...new Set(keyNames)]) {
      const response = await this.ec2Client().send(new DescribeKeyPairsCommand({
        KeyNames: [keyName],
      }));
      const keyPair = response.KeyPairs?.find((candidate) => candidate.KeyName === keyName);
      const tagPairs = (keyPair?.Tags ?? []).flatMap((tag): [string, string][] => {
        if (tag.Key === undefined || tag.Value === undefined) {
          return [];
        }
        return [[tag.Key, tag.Value]];
      });
      const tags = new Map(tagPairs);
      for (const [key, value] of Object.entries(requiredTags)) {
        if (tags.get(key) !== value) {
          throw new Error(`refusing to delete AWS key pair ${keyName}: missing required tag ${key}=${value}`);
        }
      }
    }
  }

  async assertS3ObjectsTagged(objects: readonly AwsS3ObjectRef[], requiredTags: Readonly<Record<string, string>>): Promise<void> {
    for (const object of objects) {
      if (!await this.s3ObjectHasRequiredTags(object.bucket, object.key, requiredTags)) {
        throw new Error(`refusing to delete AWS S3 object s3://${object.bucket}/${object.key}: missing required rootcell tags`);
      }
    }
  }

  async deleteS3Prefix(bucket: string, prefix: string): Promise<void> {
    let continuationToken: string | undefined;
    do {
      const listed = await this.s3Client().send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix.endsWith("/") ? prefix : `${prefix}/`,
        ContinuationToken: continuationToken,
      }));
      const objects = (listed.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => key !== undefined && key.length > 0)
        .filter((key) => this.keyIsInsidePrefix(key, prefix));
      const taggedObjects = [];
      for (const key of objects) {
        if (await this.s3ObjectHasRequiredTags(bucket, key, {
          RootcellManaged: "true",
          RootcellInstanceName: this.config.instanceName,
        })) {
          taggedObjects.push({ Key: key });
        }
      }
      if (taggedObjects.length > 0) {
        await this.s3Client().send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: taggedObjects,
            Quiet: true,
          },
        }));
      }
      continuationToken = listed.NextContinuationToken;
    } while (continuationToken !== undefined);
  }

  private async s3ObjectHasRequiredTags(
    bucket: string,
    key: string,
    requiredTags: Readonly<Record<string, string>>,
  ): Promise<boolean> {
    const response = await this.s3Client().send(new GetObjectTaggingCommand({
      Bucket: bucket,
      Key: key,
    }));
    const pairs: [string, string][] = [];
    for (const tag of response.TagSet ?? []) {
      if (tag.Key !== undefined && tag.Value !== undefined) {
        pairs.push([tag.Key, tag.Value]);
      }
    }
    const tags = new Map(pairs);
    return Object.entries(requiredTags).every(([keyName, value]) => tags.get(keyName) === value);
  }

  private keyIsInsidePrefix(key: string, prefix: string): boolean {
    const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
    return key.startsWith(normalized);
  }

  private ec2Client(): EC2Client {
    this.ec2 ??= new EC2Client(this.clientConfig());
    return this.ec2;
  }

  private s3Client(): S3Client {
    this.s3 ??= new S3Client(this.s3ClientConfig());
    return this.s3;
  }

  private stsClient(): STSClient {
    this.sts ??= new STSClient(this.stsClientConfig());
    return this.sts;
  }

  private clientConfig(): EC2ClientConfig & { readonly region: string } {
    const aws = this.requireAwsConfig();
    return {
      region: aws.region,
      credentials: this.credentials,
    };
  }

  private s3ClientConfig(): S3ClientConfig & { readonly region: string } {
    const aws = this.requireAwsConfig();
    return {
      region: aws.region,
      credentials: this.credentials,
    };
  }

  private stsClientConfig(): STSClientConfig & { readonly region: string } {
    const aws = this.requireAwsConfig();
    return {
      region: aws.region,
      credentials: this.credentials,
    };
  }

  private requireAwsConfig(): NonNullable<RootcellConfig["awsEc2"]> {
    if (this.config.awsEc2 === undefined) {
      throw new Error("AWS EC2 provider config is missing");
    }
    return this.config.awsEc2;
  }
}

function awsErrorName(error: unknown): string {
  if (error !== null && typeof error === "object" && "name" in error && typeof error.name === "string") {
    return error.name;
  }
  return "";
}
