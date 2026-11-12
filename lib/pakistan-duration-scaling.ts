/** Full text verified: Haseeb et al. (2025), Section 3.2, Eq. (1). */
export const PAKISTAN_IMD = {
  alpha: 1 / 3,
  durationsMinutes: [60,120,180,240,360,720,1440] as readonly number[],
  title: 'Forecasting Rainfall IDF Curves Using Ground Data and Downscaled Climate Projections to Enhance Flood Management in Punjab, Pakistan',
  citation: 'Haseeb, F., Ali, S., Ahmed, N., Alkhuraiji, W. S., Đurin, B., & Youssef, Y. M. (2025). Atmosphere, 16(11), 1271.',
  doi: '10.3390/atmos16111271',
  url: 'https://doi.org/10.3390/atmos16111271',
  method: 'IMD reduction formula; Section 3.2, Equation (1)',
  basis: 'Published empirical exponent used in a Punjab, Pakistan study; not a district-fitted exponent. Transfer to other districts or district-average rainfall is not independently validated.',
} as const;
