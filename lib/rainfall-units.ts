/** Exact international inch: 25.4 millimetres. Internal hydrology stays metric. */
export const MM_PER_INCH = 25.4;
export const mmHrToInchHr = (value: number) => value / MM_PER_INCH;
export const intensityPair = (value: number) => `${value.toFixed(3)} mm/hr | ${mmHrToInchHr(value).toFixed(4)} inch/hr`;
