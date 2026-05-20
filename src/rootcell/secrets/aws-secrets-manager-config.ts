import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  NonEmptyStringSchema,
  parseSchema,
} from "../schema.ts";
import { SecretProviderIdSchema } from "./types.ts";

export const AWS_SECRETS_MANAGER_PROVIDERS_ENV = "ROOTCELL_AWS_SECRETS_MANAGER_PROVIDERS";

export const AwsSecretsManagerSecretProviderConfigSchema = z.object({
  id: SecretProviderIdSchema,
  awsProfile: NonEmptyStringSchema,
  awsRegion: NonEmptyStringSchema.optional(),
}).strict();

export type AwsSecretsManagerSecretProviderConfig = Readonly<
  z.infer<typeof AwsSecretsManagerSecretProviderConfigSchema>
>;

const AwsSecretsManagerProviderEnvConfigSchema = z.object({
  aws_profile: NonEmptyStringSchema,
  aws_region: NonEmptyStringSchema.optional(),
}).strict();

type AwsSecretsManagerProviderEnvConfig = Readonly<
  z.infer<typeof AwsSecretsManagerProviderEnvConfigSchema>
>;

export function parseAwsSecretsManagerProviderConfigs(env: NodeJS.ProcessEnv): AwsSecretsManagerSecretProviderConfig[] {
  const raw = env[AWS_SECRETS_MANAGER_PROVIDERS_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${AWS_SECRETS_MANAGER_PROVIDERS_ENV} must be valid JSON: ${messageFromUnknown(error)}`, { cause: error });
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`${AWS_SECRETS_MANAGER_PROVIDERS_ENV} must be a JSON object`);
  }

  return Object.entries(parsed).map(([id, rawConfig]) => {
    const providerId = parseSchema(SecretProviderIdSchema, id, "invalid AWS Secrets Manager provider id");
    const providerConfig = parseSchema(
      AwsSecretsManagerProviderEnvConfigSchema,
      rawConfig,
      `invalid AWS Secrets Manager provider '${providerId}'`,
    );
    return configFromEnvConfig(providerId, providerConfig);
  });
}

export function resolveAwsSecretsManagerRegion(
  config: AwsSecretsManagerSecretProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (config.awsRegion !== undefined && config.awsRegion.length > 0) {
    return config.awsRegion;
  }

  const profileRegion = sharedAwsProfileRegion(config.awsProfile, env);
  if (profileRegion !== undefined && profileRegion.length > 0) {
    return profileRegion;
  }

  const envRegion = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  if (envRegion !== undefined && envRegion.length > 0) {
    return envRegion;
  }

  throw new Error(
    `AWS Secrets Manager provider '${config.id}' has no region; set aws_region in ${AWS_SECRETS_MANAGER_PROVIDERS_ENV}, set region for AWS profile '${config.awsProfile}' in ~/.aws/config, or set AWS_REGION`,
  );
}

function configFromEnvConfig(
  id: string,
  envConfig: AwsSecretsManagerProviderEnvConfig,
): AwsSecretsManagerSecretProviderConfig {
  return parseSchema(AwsSecretsManagerSecretProviderConfigSchema, {
    id,
    awsProfile: envConfig.aws_profile,
    ...(envConfig.aws_region === undefined ? {} : { awsRegion: envConfig.aws_region }),
  }, `invalid AWS Secrets Manager provider '${id}'`);
}

function sharedAwsProfileRegion(profile: string, env: NodeJS.ProcessEnv): string | undefined {
  const configRegion = profileRegionFromFile(awsConfigFile(env), profile, "config");
  if (configRegion !== undefined) {
    return configRegion;
  }
  return profileRegionFromFile(awsCredentialsFile(env), profile, "credentials");
}

function awsConfigFile(env: NodeJS.ProcessEnv): string {
  return env.AWS_CONFIG_FILE === undefined || env.AWS_CONFIG_FILE.length === 0
    ? join(homedir(), ".aws", "config")
    : env.AWS_CONFIG_FILE;
}

function awsCredentialsFile(env: NodeJS.ProcessEnv): string {
  return env.AWS_SHARED_CREDENTIALS_FILE === undefined || env.AWS_SHARED_CREDENTIALS_FILE.length === 0
    ? join(homedir(), ".aws", "credentials")
    : env.AWS_SHARED_CREDENTIALS_FILE;
}

function profileRegionFromFile(path: string, profile: string, kind: "config" | "credentials"): string | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  const sections = parseIniSections(readFileSync(path, "utf8"));
  const sectionNames = kind === "config" && profile !== "default"
    ? [`profile ${profile}`]
    : [profile];
  for (const sectionName of sectionNames) {
    const region = sections.get(sectionName)?.get("region");
    if (region !== undefined && region.length > 0) {
      return region;
    }
  }
  return undefined;
}

function parseIniSections(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let currentSection: Map<string, string> | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      const name = line.slice(1, -1).trim();
      currentSection = new Map<string, string>();
      sections.set(name, currentSection);
      continue;
    }
    if (currentSection === undefined) {
      continue;
    }
    const equalsAt = line.indexOf("=");
    if (equalsAt === -1) {
      continue;
    }
    const key = line.slice(0, equalsAt).trim();
    const value = line.slice(equalsAt + 1).trim();
    currentSection.set(key, value);
  }

  return sections;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
