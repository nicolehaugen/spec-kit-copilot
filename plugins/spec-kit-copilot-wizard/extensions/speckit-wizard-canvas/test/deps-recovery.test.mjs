// Unit tests for env/deps-recovery.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildNpmDiagnosticPrompt } from "../env/deps-recovery.mjs";
import { getDependencyDir, getExtensionDir } from "../env/deps-check.mjs";
import { join } from "node:path";

test("Wizard setup tracks both runtime dependencies in their own extensions", () => {
    assert.equal(getDependencyDir("js-yaml"), getExtensionDir());
    assert.equal(getDependencyDir("es-module-lexer"),
        join(getExtensionDir(), "..", "speckit-canvas-designer"));
    assert.throws(() => getDependencyDir("unknown"), /Unknown Wizard dependency/);
});

test("throws when extDir is missing", () => {
    assert.throws(
        () => buildNpmDiagnosticPrompt({ errorCode: "UNKNOWN" }),
        /requires extDir/,
    );
});

test("includes extDir verbatim in the retry step", () => {
    const p = buildNpmDiagnosticPrompt({
        extDir: "C:\\Users\\me\\ext",
        errorCode: "TLS_HANDSHAKE",
        stderr: "schannel: SEC_E_ILLEGAL_MESSAGE",
    });
    assert.ok(p.includes("C:\\Users\\me\\ext"));
    assert.match(p, /npm ci --omit=dev --no-audit --no-fund/);
});

test("Designer dependency failures diagnose the Designer directory and package", () => {
    const p = buildNpmDiagnosticPrompt({
        extDir: "C:\\plugins\\speckit-canvas-designer",
        packageName: "es-module-lexer",
        errorCode: "HTTP_403",
    });
    assert.match(p, /failed to install es-module-lexer/);
    assert.match(p, /npm ci --omit=dev --no-audit --no-fund.*es-module-lexer/);
    assert.match(p, /C:\\plugins\\speckit-canvas-designer/);
});

test("mentions the classified error code and includes a code-specific hint", () => {
    const tls = buildNpmDiagnosticPrompt({
        extDir: "/x",
        errorCode: "TLS_HANDSHAKE",
        stderr: "",
    });
    assert.match(tls, /TLS_HANDSHAKE/);
    assert.match(tls, /Focus on TLS/);

    const cert = buildNpmDiagnosticPrompt({ extDir: "/x", errorCode: "CERT_UNTRUSTED" });
    assert.match(cert, /Focus on certificates/);

    const proxy = buildNpmDiagnosticPrompt({ extDir: "/x", errorCode: "HTTP_407_PROXY" });
    assert.match(proxy, /Focus on proxy/);

    const dns = buildNpmDiagnosticPrompt({ extDir: "/x", errorCode: "DNS_UNRESOLVED" });
    assert.match(dns, /Focus on DNS/);

    const missing = buildNpmDiagnosticPrompt({ extDir: "/x", errorCode: "NPM_MISSING" });
    assert.match(missing, /npm is not installed|not on PATH/);
});

test("falls back to UNKNOWN hint for unknown codes", () => {
    const p = buildNpmDiagnosticPrompt({ extDir: "/x", errorCode: "SOMETHING_ELSE" });
    assert.match(p, /did not match a known pattern/);
});

test("truncates very long stderr", () => {
    const long = "x".repeat(5000);
    const p = buildNpmDiagnosticPrompt({ extDir: "/x", errorCode: "UNKNOWN", stderr: long });
    assert.ok(p.includes("(truncated)"));
    assert.ok(p.length < long.length + 2000);
});

test("workspacePath appears when provided", () => {
    const p = buildNpmDiagnosticPrompt({
        extDir: "/x",
        errorCode: "UNKNOWN",
        workspacePath: "/home/nicole/repo",
    });
    assert.match(p, /User workspace: \/home\/nicole\/repo/);
});

test("prompt tells the agent to use the Wizard retry control on success", () => {
    const p = buildNpmDiagnosticPrompt({ extDir: "/x", errorCode: "UNKNOWN" });
    assert.match(p, /click Retry in the Wizard/);
});
