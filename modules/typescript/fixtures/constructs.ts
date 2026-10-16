// Fixture for plan 02-13: every definition construct of the typescript module.
// The expected items live in constructs.truth.json. That file was written by reading this one,
// before the extractor was run on it. Line numbers there are 1-based editor line numbers.

export function exportedPlain(a: number): number {
  return a + 1;
}

async function asyncPlain(): Promise<void> {
  await Promise.resolve();
}

function* generatorPlain(): Generator<number> {
  yield 1;
}

export default function defaultNamed(): void {}

function overloaded(x: string): string;
function overloaded(x: number): number;
function overloaded(x: unknown): unknown {
  return x;
}

function outer(): number {
  function inner(): number {
    return 1;
  }
  const localArrow = (): number => inner();
  const localValue = 42;
  let localCounter = 0;
  return localArrow() + localValue + localCounter;
}

const arrowTop = (n: number): number => n * 2;
export const exportedArrow = async (n: number): Promise<number> => n;
const exprTop = function named(): void {};
var varArrow = () => 1;

const LIMIT = 10;
let counter = 0;
var legacy = 'old';
export const EXPORTED_CONST = { a: 1 };
const first = 1, second = 2;
const { destructuredA, destructuredB } = { destructuredA: 1, destructuredB: 2 };

class Plain {
  field = 1;
  static shared: string = 'x';
  private secret = 2;
  #hidden = 3;
  constructor(public readonly id: number) {}
  method(): number {
    return this.field;
  }
  static create(): Plain {
    return new Plain(1);
  }
  private helper(): void {}
  #privateMethod(): void {}
  get value(): number {
    return this.field;
  }
  set value(v: number) {
    this.field = v;
  }
  over(a: string): void;
  over(a: number): void;
  over(a: unknown): void {}
  async load(): Promise<void> {}
}

export abstract class Shape {
  abstract area(): number;
  describe(): string {
    return `${this.area()}`;
  }
}

class Box<T extends object = {}> {
  value!: T;
  map<U>(fn: (t: T) => U): U {
    return fn(this.value);
  }
}

function sealed(target: Function): void {}

@sealed
class Decorated {
  @sealed decoratedMethod(): void {}
}

@sealed export class DecoratedExported {}

export class Child extends Plain {
  extra = 'e';
}

export interface Named {
  readonly name: string;
  label?: string;
  describe(): string;
}

interface Extended<T> extends Named {
  extra: T;
  onChange(listener: (value: T) => void): void;
  [key: string]: unknown;
}

type Id = string | number;
export type Pair<A, B> = [A, B];
type Mapper = { run(x: number): number; size: number };

enum Color {
  Red,
  Green,
}
export enum Level {
  Low = 1,
  High,
}
const enum Flags {
  A = 1,
}
declare enum Ambient {
  X,
}

namespace Util {
  export function helper(): number {
    return 1;
  }
  export const LIMIT_IN_NS = 10;
}

declare function ambientFn(x: number): void;
declare class AmbientClass {
  ambientMethod(): void;
}

function café(): void {}
class Ünïcode {
  naïve = 1;
}
const tag = '😀'; function afterEmoji(): void {}
const 变量 = 1;
export declare function exportedAmbient(x: number): void;
export declare class ExportedAmbientClass {}
export declare enum ExportedAmbientEnum { Y }
