import { describe, it, expect } from "vitest";
import { classifyFailure } from "../../src/notify/classifyFailure.js";

describe("classifyFailure", () => {
  it.each([
    ["TypeError: fetch failed"],
    ["Error: fetch failed"],
    ["connect ECONNREFUSED 127.0.0.1:3501"],
    ["read ECONNRESET"],
    ["connect ETIMEDOUT 10.0.0.5:443"],
    ["getaddrinfo ENOTFOUND api.example.com"],
    ["getaddrinfo EAI_AGAIN api.example.com"],
    ["socket hang up"],
    ["Socket Hang Up"],
    ["request timeout after 30000ms"],
    ["network timeout at https://foo"],
    ["HTTP 502: upstream connect error"],
    ["HTTP 503: service unavailable"],
    ["HTTP 504: gateway timeout"],
  ])("classifies %p as transient_network", (msg) => {
    expect(classifyFailure(msg)).toBe("transient_network");
  });

  it.each([
    ["TypeError: Cannot read properties of undefined (reading 'foo')"],
    ["SyntaxError: Unexpected token }"],
    ["invalid url: not-a-url"],
    ["HTTP 400: bad request"],
    ["HTTP 401: unauthorized"],
    ["HTTP 404: not found"],
    ["HTTP 500: application error: missing env var"],
    ["ReferenceError: foo is not defined"],
    ["Error: task config validation failed"],
  ])("classifies %p as task_issue", (msg) => {
    expect(classifyFailure(msg)).toBe("task_issue");
  });

  it("classifies null as task_issue (conservative default)", () => {
    expect(classifyFailure(null)).toBe("task_issue");
  });

  it("classifies empty string as task_issue", () => {
    expect(classifyFailure("")).toBe("task_issue");
  });
});
