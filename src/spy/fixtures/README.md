# Spy Fixtures

`bedrock-pi-us-sonnet-4-6.ndjson` is a credential-redacted capture from the
existing `default` rootcell instance using Pi with Amazon Bedrock model
`us.anthropic.claude-sonnet-4-6`.

The fixture preserves real Bedrock request bodies and AWS event-stream response
bytes. Header/query credential redaction stayed enabled during capture; fixture
generation also stabilized flow ids, timestamps, request ids, and SDK invocation
ids.

Captured cases:

- simple streaming prompt/response
- two-turn session history
- cache markers emitted by Pi
- toolUse stream response
- follow-up request containing toolResult
- provider-reported usage metadata
