import { Base, type Shape } from './lib.cjs';
import { useTyped } from './user.cjs';

export class Sub extends Base {}
export class Boom extends Error {}
export interface Square extends Shape {
  side: number;
}

export function total(): number {
  return useTyped();
}
