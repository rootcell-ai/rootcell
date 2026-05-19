import { z } from "zod";
import { NonEmptyStringSchema, PositiveSafeIntegerSchema } from "../../../schema.ts";

export const LimaVmStateFileSchema = z.object({
  provider: z.literal("lima"),
  name: NonEmptyStringSchema,
  role: z.enum(["agent", "firewall"]),
  limaInstance: NonEmptyStringSchema,
  yamlPath: NonEmptyStringSchema,
  privateInterface: NonEmptyStringSchema,
  egressInterface: NonEmptyStringSchema.optional(),
  privateIp: NonEmptyStringSchema,
  networkName: NonEmptyStringSchema,
  hasEgress: z.boolean(),
  sshLocalPort: PositiveSafeIntegerSchema.optional(),
  userV2Ready: z.boolean().optional(),
}).strict();

export const LimaNetworkAttachmentSchema = z.object({
  kind: z.literal("lima-user-v2"),
  role: z.enum(["agent", "firewall"]),
  limaInstance: NonEmptyStringSchema,
  networkName: NonEmptyStringSchema,
  privateInterface: NonEmptyStringSchema,
  egressInterface: NonEmptyStringSchema.optional(),
  privateIp: NonEmptyStringSchema,
  gatewayIp: NonEmptyStringSchema,
  dnsIp: NonEmptyStringSchema,
  reservedIps: z.array(NonEmptyStringSchema),
  hasEgress: z.boolean(),
}).strict();
