import { z } from "zod";
import {
  EnvironmentVariableNameSchema,
  NonEmptyStringSchema,
} from "../schema.ts";

export const SecretProviderIdSchema = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "must be a valid secret provider id");

export const SecretReferenceSchema = z.object({
  providerId: SecretProviderIdSchema,
  reference: NonEmptyStringSchema,
}).strict();

export type SecretReference = Readonly<z.infer<typeof SecretReferenceSchema>>;

export const SecretEnvMappingSchema = z.object({
  envName: EnvironmentVariableNameSchema,
  secret: SecretReferenceSchema,
}).strict();

type SecretEnvMappingOutput = z.infer<typeof SecretEnvMappingSchema>;

export type SecretEnvMapping = Readonly<
  Omit<SecretEnvMappingOutput, "secret"> & {
    readonly secret: SecretReference;
  }
>;

export interface SecretProvider {
  readonly id: string;
  read(reference: string): Promise<string>;
}

export interface SecretProviderRegistry {
  readonly ids: readonly string[];
  read(secret: SecretReference): Promise<string>;
}
