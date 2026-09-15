# Third-party licenses and notices

This public seed contains captured documentation bodies from the fixed upstream
revisions listed below. The `content_sha256` values are SHA-256 hashes of the
captured body after its local YAML frontmatter. Each source file has local
provenance frontmatter added by this seed; its captured body is unchanged. The
source ID, revision, applicable license scope, attribution, and hash below must
stay aligned with `public/kb/sources.jsonl`.

| Source | Upstream revision | Applicable license scope | Captured body SHA-256 |
| --- | --- | --- | --- |
| S0001 OpenAI Agents SDK run-context reference | `fbf59a40e9da5adb88d370fefaeaae0478376d4a` | MIT | `6f6e677a59bc208fbda8f8ca050fd5a9e297d18b5cfaf16fb595dca97b7d10ce` |
| S0002 A2A core concepts | `6d6640c29b102f7a8d23784901351b5d2454fe71` | Apache-2.0 | `5dff7b765a083546622d0939b88d9ed45ee63b980f19447d6a1e6d49526a8e7e` |
| S0003 MCP repository README | `2997f33bf6e4aab3db48d755fc877c8feab32c71` | CC-BY-4.0 for documentation excluding specifications | `7e98444c73ed5d923a3b02b1247e9cdf678d31a30cc32b1503bdcd906aa984e2` |

## Packaging modification statement

The seed adds local YAML frontmatter to each captured source file so that
provenance, revision, license scope, notice reference, and the body hash travel
with the citation. No captured upstream source body was rewritten. The seed's
own metadata, concept, map, test, and notice files are original packaging work;
they are not presented as upstream material.

No separate upstream `NOTICE` file was present at the fixed revision paths
checked for these three repositories. The attribution and license terms needed
for redistribution are included here rather than represented only by links.

## S0001 — OpenAI Agents SDK

The captured file is documentation from `openai/openai-agents-python`, authored
by OpenAI, under the MIT License. The upstream license identifies copyright
`Copyright (c) 2025 OpenAI`; that copyright notice and the permission notice
are reproduced below as required for copies or substantial portions.

### MIT License

Copyright (c) 2025 OpenAI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## S0002 — A2A

The captured file is documentation from `a2aproject/A2A` under the Apache
License, Version 2.0. The fixed revision had no separate `NOTICE` file. The
complete license is retained as exact upstream bytes at the URL and digest
below; it is not hand-transcribed.

- Official fixed-revision URL: https://raw.githubusercontent.com/a2aproject/A2A/6d6640c29b102f7a8d23784901351b5d2454fe71/LICENSE
- Exact local notice bytes: `public/third-party/a2a-LICENSE`
- SHA-256: `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`

## S0003 — Model Context Protocol

The captured file is the repository `README.md`, which is documentation and
not a specification. At the fixed revision, the upstream `LICENSE` contains
the licensing transition terms and the applicable CC-BY-4.0 documentation
notice. The exact license bytes are retained at the URL and digest below; they
are not hand-transcribed.

- Official fixed-revision URL: https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/2997f33bf6e4aab3db48d755fc877c8feab32c71/LICENSE
- Exact local notice bytes: `public/third-party/mcp-LICENSE`
- SHA-256: `0382b0057770ca05e9c350a50aa3b1c1fea84da0bc81d723bf00b9aa841be58a`
