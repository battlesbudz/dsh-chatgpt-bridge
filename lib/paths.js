/**
 * Shared path comparison for workspace matching and containment checks.
 * Identity only — does not resolve relative segments.
 */
export function normalizePath(path) {
    const stripped = path.replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? stripped.toLowerCase() : stripped;
}
export function pathsEqual(left, right) {
    return normalizePath(left) === normalizePath(right);
}
