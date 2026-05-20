import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type GetSecretValueCommandOutput,
  type SecretsManagerClientConfig,
} from "@aws-sdk/client-secrets-manager";
import { fromIni } from "@aws-sdk/credential-providers";
import {
  resolveAwsSecretsManagerRegion,
  type AwsSecretsManagerSecretProviderConfig,
} from "./aws-secrets-manager-config.ts";
import type { SecretProvider } from "./types.ts";

export interface AwsSecretsManagerClientLike {
  send(command: GetSecretValueCommand): Promise<GetSecretValueCommandOutput>;
}

export type AwsSecretsManagerClientFactory = (
  config: SecretsManagerClientConfig & { readonly region: string },
) => AwsSecretsManagerClientLike;

export type AwsCredentialFactory = (profile: string) => NonNullable<SecretsManagerClientConfig["credentials"]>;

export interface AwsSecretsManagerSecretProviderOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly clientFactory?: AwsSecretsManagerClientFactory;
  readonly credentialFactory?: AwsCredentialFactory;
}

export class AwsSecretsManagerSecretProvider implements SecretProvider {
  readonly id: string;
  private client: AwsSecretsManagerClientLike | undefined;

  constructor(
    private readonly config: AwsSecretsManagerSecretProviderConfig,
    private readonly options: AwsSecretsManagerSecretProviderOptions = {},
  ) {
    this.id = config.id;
  }

  async read(reference: string): Promise<string> {
    if (reference.startsWith("arn:")) {
      throw new Error("AWS Secrets Manager references must be secret resource names, not ARNs");
    }

    const response = await this.getClient().send(new GetSecretValueCommand({
      SecretId: reference,
    }));

    if (response.SecretString !== undefined) {
      return response.SecretString;
    }
    if (response.SecretBinary !== undefined) {
      throw new Error(`AWS Secrets Manager provider '${this.id}' returned SecretBinary; configure the secret as a string value`);
    }
    throw new Error(`AWS Secrets Manager provider '${this.id}' returned no SecretString`);
  }

  private getClient(): AwsSecretsManagerClientLike {
    if (this.client !== undefined) {
      return this.client;
    }

    const region = resolveAwsSecretsManagerRegion(this.config, this.options.env);
    const credentials = (this.options.credentialFactory ?? defaultCredentialFactory)(this.config.awsProfile);
    this.client = (this.options.clientFactory ?? defaultClientFactory)({
      region,
      credentials,
    });
    return this.client;
  }
}

const defaultClientFactory: AwsSecretsManagerClientFactory = (config) => new SecretsManagerClient(config);

const defaultCredentialFactory: AwsCredentialFactory = (profile) => fromIni({ profile });
