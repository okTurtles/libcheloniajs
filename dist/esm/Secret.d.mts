import { serdesDeserializeSymbol, serdesSerializeSymbol, serdesTagSymbol } from '@chelonia/serdes';
export declare class Secret<T> {
    static [serdesDeserializeSymbol]<T>(secret: T): Secret<T>;
    static [serdesSerializeSymbol]<T>(secret: Secret<T>): any;
    static get [serdesTagSymbol](): string;
    constructor(value: T);
    valueOf(): T;
}
