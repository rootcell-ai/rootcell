import { parseSchema } from "../schema.ts";
import {
  SecretProviderIdSchema,
  type SecretProvider,
  type SecretProviderRegistry,
  type SecretReference,
} from "./types.ts";

export class StaticSecretProviderRegistry implements SecretProviderRegistry {
  private readonly providers: ReadonlyMap<string, SecretProvider>;

  constructor(providers: readonly SecretProvider[]) {
    const entries: [string, SecretProvider][] = [];
    const seen = new Set<string>();
    for (const provider of providers) {
      const id = parseSchema(SecretProviderIdSchema, provider.id, "invalid secret provider id");
      if (seen.has(id)) {
        throw new Error(`duplicate secret provider id '${id}'`);
      }
      seen.add(id);
      entries.push([id, provider]);
    }
    this.providers = new Map(entries);
  }

  get ids(): readonly string[] {
    return [...this.providers.keys()];
  }

  async read(secret: SecretReference): Promise<string> {
    const provider = this.providers.get(secret.providerId);
    if (provider === undefined) {
      throw new Error(`unknown secret provider '${secret.providerId}' in secrets.env; configured providers: ${this.providerList()}`);
    }
    return await provider.read(secret.reference);
  }

  private providerList(): string {
    const ids = this.ids;
    return ids.length === 0 ? "(none)" : ids.join(", ");
  }
}
