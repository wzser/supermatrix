# generic

## Triggers

- no explicit pack is requested
- the target page is not clearly Amazon or Helium 10
- the task is general browsing: reading, clicking, form fills, DOM extraction, media URL collection

## Schema

No fixed business schema. Extract only what the task asks for.

Profiles define browser identity and account context; `generic` defines only the business logic for general browsing tasks.

## Flow

1. ensure the selected managed Chrome profile is available
2. open a temporary working tab
3. inspect the page structure before choosing the next interaction
4. extract only the requested content
5. close the working tab unless the user asks to keep it open

## Cleaners

- trim and normalize whitespace
- preserve original wording unless normalization is explicitly requested
- return URLs as absolute when possible

## Known Traps

- do not overfit a site-specific flow when the task is generic
- do not keep tabs open by default (memory + tab hygiene)
- avoid reformatting or "summarizing" when the user asked for raw page content
