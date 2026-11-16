/** A retained frame/result exceeds its bound; lifetime stream traffic is not retained memory. */
export class OutputLimitError extends Error {
  constructor(message: string) { super(message); this.name = 'OutputLimitError' }
}
