/**
 * Shared path comparison for workspace matching and containment checks.
 * Identity only — does not resolve relative segments.
 */
export declare function normalizePath(path: string): string;
export declare function pathsEqual(left: string, right: string): boolean;
