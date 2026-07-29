class SeededRandom {
  private seed: number

  constructor(seed: string | number) {
    this.seed = this.hashString(String(seed))
  }

  private hashString(str: string): number {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash = hash & hash
    }
    return Math.abs(hash)
  }

  next(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0
    return this.seed / 4294967296
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min)
  }

  floor(min: number, max: number): number {
    return Math.floor(this.range(min, max))
  }
}

export = SeededRandom
