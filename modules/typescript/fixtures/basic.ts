function greet(name: string): string {
  return `hello ${name}`;
}

class Greeter {
  constructor(private readonly prefix: string) {}
}
