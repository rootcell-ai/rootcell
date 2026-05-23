export interface AwsEventStreamMessage {
  readonly headers: Readonly<Record<string, unknown>>;
  readonly payload: Uint8Array;
}

export class AwsEventStreamDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwsEventStreamDecodeError";
  }
}

export function decodeAwsEventStream(input: Uint8Array | string): AwsEventStreamMessage[] {
  const data = typeof input === "string" ? Buffer.from(input, "base64") : Buffer.from(input);
  const messages: AwsEventStreamMessage[] = [];
  let offset = 0;

  while (offset < data.length) {
    if (data.length - offset < 16) {
      throw new AwsEventStreamDecodeError("truncated prelude");
    }

    const totalLength = data.readUInt32BE(offset);
    const headersLength = data.readUInt32BE(offset + 4);
    if (totalLength < 16) {
      throw new AwsEventStreamDecodeError(`invalid total length ${String(totalLength)}`);
    }
    const end = offset + totalLength;
    if (end > data.length) {
      throw new AwsEventStreamDecodeError("truncated message");
    }

    const preludeCrc = data.readUInt32BE(offset + 8);
    if (crc32(data.subarray(offset, offset + 8)) !== preludeCrc) {
      throw new AwsEventStreamDecodeError("prelude CRC mismatch");
    }

    const messageCrc = data.readUInt32BE(end - 4);
    if (crc32(data.subarray(offset, end - 4)) !== messageCrc) {
      throw new AwsEventStreamDecodeError("message CRC mismatch");
    }

    const headersStart = offset + 12;
    const headersEnd = headersStart + headersLength;
    if (headersEnd > end - 4) {
      throw new AwsEventStreamDecodeError("headers exceed message");
    }

    messages.push({
      headers: decodeHeaders(data.subarray(headersStart, headersEnd)),
      payload: data.subarray(headersEnd, end - 4),
    });
    offset = end;
  }

  return messages;
}

export function decodeAwsEventStreamJson(input: Uint8Array | string): {
  readonly headers: Readonly<Record<string, unknown>>;
  readonly payload: unknown;
}[] {
  const decoder = new TextDecoder();
  return decodeAwsEventStream(input).map((message) => ({
    headers: message.headers,
    payload: JSON.parse(decoder.decode(message.payload)) as unknown,
  }));
}

function decodeHeaders(data: Buffer): Record<string, unknown> {
  const headers: Record<string, unknown> = {};
  let offset = 0;
  while (offset < data.length) {
    const nameLength = data[offset];
    offset += 1;
    if (nameLength === undefined || offset + nameLength + 1 > data.length) {
      throw new AwsEventStreamDecodeError("truncated header");
    }

    const name = data.subarray(offset, offset + nameLength).toString("utf8");
    offset += nameLength;
    const valueType = data[offset];
    offset += 1;

    if (valueType === 0) {
      headers[name] = true;
    } else if (valueType === 1) {
      headers[name] = false;
    } else if (valueType === 2) {
      headers[name] = data.readInt8(offset);
      offset += 1;
    } else if (valueType === 3) {
      headers[name] = data.readInt16BE(offset);
      offset += 2;
    } else if (valueType === 4) {
      headers[name] = data.readInt32BE(offset);
      offset += 4;
    } else if (valueType === 5) {
      headers[name] = Number(data.readBigInt64BE(offset));
      offset += 8;
    } else if (valueType === 6 || valueType === 7) {
      const length = data.readUInt16BE(offset);
      offset += 2;
      const raw = data.subarray(offset, offset + length);
      offset += length;
      headers[name] = valueType === 6 ? new Uint8Array(raw) : raw.toString("utf8");
    } else if (valueType === 8) {
      const millis = Number(data.readBigInt64BE(offset));
      offset += 8;
      headers[name] = new Date(millis).toISOString();
    } else if (valueType === 9) {
      headers[name] = data.subarray(offset, offset + 16).toString("hex");
      offset += 16;
    } else {
      throw new AwsEventStreamDecodeError(`unknown header type ${String(valueType)}`);
    }
  }
  return headers;
}

// Small table-driven CRC32 implementation to avoid adding a dependency for AWS
// event-stream validation.
const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC32_TABLE[index] = value >>> 0;
}

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (const byte of data) {
    crc = (CRC32_TABLE[(crc ^ byte) & 0xFF] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
