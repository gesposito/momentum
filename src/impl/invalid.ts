export default class Invalid {
  readonly reason: string;
  readonly explanation: string | null;

  constructor(reason: string, explanation: string | null = null) {
    this.reason = reason;
    this.explanation = explanation;
  }

  toMessage(): string {
    if (this.explanation) {
      return `${this.reason}: ${this.explanation}`;
    } else {
      return this.reason;
    }
  }
}
