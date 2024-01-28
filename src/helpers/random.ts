const random = (seed: number) => {
  const _seed = (s: number) => {
    if ((seed = (s | 0) % 2147483647) <= 0) {
      seed += 2147483646;
    }
  };

  const _nextInt = () => (seed = (seed * 48271) % 2147483647);

  const _nextFloat = () => (_nextInt() - 1) / 2147483646;

  _seed(seed);

  return {
    seed: _seed,
    nextInt: _nextInt,
    nextFloat: _nextFloat,
  };
};

export default random;
