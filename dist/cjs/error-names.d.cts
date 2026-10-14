export declare function hasErrorName<N extends string>(e: unknown, ...names: N[]): e is Error & {
    name: N;
};
