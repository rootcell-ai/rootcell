import {
  BedrockRuntimeClient,
  CountTokensCommand,
  type CountTokensCommandInput,
} from "@aws-sdk/client-bedrock-runtime";

export interface BedrockTokenCounter {
  count(input: BedrockTokenCountInput): Promise<number>;
}

export interface BedrockTokenCountInput {
  readonly modelId: string;
  readonly input: CountTokensCommandInput["input"];
}

export class AwsBedrockTokenCounter implements BedrockTokenCounter {
  private readonly client: BedrockRuntimeClient;

  constructor(options: { readonly region: string }) {
    this.client = new BedrockRuntimeClient({ region: options.region });
  }

  async count(input: BedrockTokenCountInput): Promise<number> {
    const response = await this.client.send(new CountTokensCommand({
      modelId: bedrockTokenCountModelId(input.modelId),
      input: input.input,
    }));
    if (response.inputTokens === undefined) {
      throw new Error("Bedrock CountTokens returned no inputTokens value");
    }
    return response.inputTokens;
  }
}

export function bedrockTokenCountModelId(modelId: string): string {
  const match = /^(?:us|eu|au|global)\.(anthropic\.claude-.+)$/.exec(modelId);
  return match?.[1] ?? modelId;
}

export function bedrockCountInputFromRequestBody(bodyText: string): CountTokensCommandInput["input"] | null {
  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(body)) {
    return null;
  }

  const converse: Record<string, unknown> = {};
  copyIfPresent(body, converse, "messages");
  copyIfPresent(body, converse, "system");
  copyIfPresent(body, converse, "toolConfig");
  copyIfPresent(body, converse, "additionalModelRequestFields");
  return Object.keys(converse).length === 0 ? null : { converse };
}

export function bedrockCountInputForText(text: string): CountTokensCommandInput["input"] {
  return {
    converse: {
      messages: [
        {
          role: "user",
          content: [{ text }],
        },
      ],
    },
  };
}

function copyIfPresent(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  if (source[key] !== undefined) {
    target[key] = source[key];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
