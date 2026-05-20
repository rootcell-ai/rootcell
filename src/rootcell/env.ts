import { existsSync, readFileSync } from "node:fs";
import { EnvironmentVariableNameSchema } from "./schema.ts";
import {
  SecretEnvMappingSchema,
  SecretProviderIdSchema,
  type SecretEnvMapping,
} from "./secrets/types.ts";

export function loadDotEnv(path: string, env: NodeJS.ProcessEnv): void {
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const equalsAt = line.indexOf("=");
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const key = equalsAt === -1 ? line : line.slice(0, equalsAt);
    const value = equalsAt === -1 ? "" : line.slice(equalsAt + 1);
    if (!EnvironmentVariableNameSchema.safeParse(key).success) {
      throw new Error(`invalid environment variable name in .env: ${key}`);
    }
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      continue;
    }
    env[key] = value;
  }
}

export function parseSecretMappings(text: string): SecretEnvMapping[] {
  const mappings: SecretEnvMapping[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const equalsAt = line.indexOf("=");
    if (equalsAt === -1) {
      throw new Error(`invalid secret entry in secrets.env: ${line}`);
    }
    const envName = line.slice(0, equalsAt);
    const service = line.slice(equalsAt + 1);
    if (!EnvironmentVariableNameSchema.safeParse(envName).success) {
      throw new Error(`invalid secret environment variable name in secrets.env: ${envName}`);
    }
    if (service.length === 0) {
      throw new Error(`empty secret reference for ${envName}`);
    }
    const separatorAt = service.indexOf(":");
    if (separatorAt === -1) {
      throw new Error(`secret reference for ${envName} must include a provider id, for example macos-keychain:${service}`);
    }
    const providerId = service.slice(0, separatorAt);
    const reference = service.slice(separatorAt + 1);
    if (providerId.length === 0) {
      throw new Error(`empty secret provider id for ${envName}`);
    }
    if (!SecretProviderIdSchema.safeParse(providerId).success) {
      throw new Error(`invalid secret provider id in secrets.env for ${envName}: ${providerId}`);
    }
    if (reference.length === 0) {
      throw new Error(`empty secret reference for ${envName}`);
    }
    mappings.push(SecretEnvMappingSchema.parse({
      envName,
      secret: { providerId, reference },
    }));
  }
  return mappings;
}

export function nixString(value: string): string {
  return JSON.stringify(value);
}
