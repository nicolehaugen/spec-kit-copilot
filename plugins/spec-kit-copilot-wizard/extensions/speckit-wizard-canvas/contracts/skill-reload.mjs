// Session skill reload diagnostics gate Spec Kit setup only for Spec Kit
// skills. The host reports errors for every skill it scans (for example
// "Failed to load skill '<dir>/SKILL.md': ..."), so a malformed unrelated
// repository or user skill must not block Wizard setup or Designer launches.
// An error blocks only when it names a `speckit-*` skill directory or skill.
const SPECKIT_SKILL = /(?:^|[\\/'"`\s])speckit-[a-z0-9][a-z0-9.-]*(?=[\\/]SKILL\.md|['"`\s:,;)]|$)/i;

export function specKitSkillReloadErrors(errors) {
    return Array.isArray(errors)
        ? errors.filter((message) => typeof message === "string" && SPECKIT_SKILL.test(message.split(": ", 1)[0]))
        : [];
}
