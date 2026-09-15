# Interview prompts

Replace bracketed values locally. Do not put private identifiers into a public
copy of this file.

## A: caller

```text
I am reviewing one communication from [caller] to [target] at [time].
Source reference: [communication reference].

1. What were you trying to accomplish, and why did you contact [target]?
2. What exact answer, action, or judgment did you expect?
3. After the reply, could you continue? If not, what did you repeat or ask for?
```

## B: target

```text
I am reviewing one request from [caller] at [time].
Prompt: [prompt]

1. What did you understand the request to mean?
2. Why did you return [reply summary]?
3. Did you believe the requested outcome was complete? What was uncertain?
```

Both requests use Spawn2.0 v2:

```json
{
  "from": "<local-session>",
  "target": "<interviewee-session>",
  "prompt": "<one prompt>",
  "client_request_id": "YYYY-MM-DD:<local-session>:<interviewee>:judgment-interview:<case-key>",
  "closure": {"kind": "message", "target": {"type": "inline"}}
}
```
