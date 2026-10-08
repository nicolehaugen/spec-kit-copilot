function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical).sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
}

function targets(badge) {
    if (badge.targets?.length) return badge.targets;
    if (badge.showIn?.includes("phase-card") && badge.phase) {
        return [{ phase: badge.phase, output: null }];
    }
    return [{ phase: null, output: null }];
}

export function findDuplicateBadge(candidate, existing) {
    const inputs = JSON.stringify(canonical(candidate.inputs));
    const destinations = new Set(targets(candidate).map(({ phase, output }) =>
        JSON.stringify([phase, output])));
    return existing.find((badge) => badge.id !== candidate.id && badge.type === candidate.type
        && badge.text === candidate.text
        && badge.phaseText === candidate.phaseText
        && badge.summaryText === candidate.summaryText
        && JSON.stringify(canonical(badge.inputs)) === inputs
        && targets(badge).some(({ phase, output }) =>
            destinations.has(JSON.stringify([phase, output]))));
}
