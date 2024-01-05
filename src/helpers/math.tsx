// Define a logarithmic function
export const logLimit = (x: number, limit: number) => {
  const sign = Math.sign(x);
  x = Math.abs(x);
  if (x > limit) {
    return sign * (Math.log(x - limit + 1) + limit);
  }
  return sign * x;
};
