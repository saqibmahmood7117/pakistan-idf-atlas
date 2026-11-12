# Pakistan literature basis for daily duration scaling

## Verified source

Haseeb, F., Ali, S., Ahmed, N., Alkhuraiji, W. S., Đurin, B., & Youssef,
Y. M. (2025). *Forecasting Rainfall IDF Curves Using Ground Data and Downscaled
Climate Projections to Enhance Flood Management in Punjab, Pakistan*.
Atmosphere, 16(11), 1271. https://doi.org/10.3390/atmos16111271

The complete publisher PDF was retrieved and its methods checked on
12 November 2026:
https://mdpi-res.com/d_attachment/atmosphere/atmosphere-16-01271/article_deploy/atmosphere-16-01271.pdf

Section 3.2, Equation (1), explicitly applies the IMD reduction formula:

`P_d = P_24 (d/24)^(1/3)`, with d in hours.

It explicitly computes 1, 2, 3, 4, 6, 12 and 24 hours from the annual daily
maximum series. Converting hours to minutes gives
`P_t = P_24 (t/1440)^(1/3)`. Mean intensity is `i_t=60 P_t/t`, or
`i_t=i_24 (t/1440)^(-2/3)`.

## Implemented scope

The default CMIP6 duration method is **Pakistan literature · IMD one-third**.
The exact exponent is `1/3`, replacing the prior unexplained rounded `0.33`.
Plots, calculator range, report matrices and Excel equations use the paper's
seven durations (60–1440 minutes), including 240 minutes. The calculator
interpolates its displayed power equation inside this range; it rejects
sub-hour inputs. The 24-hour value is preserved.

The Atlas applies this positive depth multiplier to fitted daily return levels
and their interval bounds after available daily correction. For scale-equivariant
estimators such as its GEV L-moment fit, multiplying daily annual maxima by the
same positive constant and then fitting yields the same scaled return levels.
This implementation adopts the paper's duration-reduction component only. It
does not claim to reproduce that paper's EQM correction, GCM selection, LP3
model choice, or its location-specific design equations.

The new **Duration Scaling** Excel sheet records the method, exponent, equation,
durations, citation, DOI, ordering and limitations. Reports include the same basis.

## Interpretation limits

One-third is a published empirical selection, **not a newly estimated district
exponent**. The publication concerns Punjab cities; transfer outside that scope
or from station rainfall to district averages is not independently validated.
Daily observations alone cannot estimate a sub-daily depth-duration exponent.

The method does not create native sub-daily observations, a continuous sub-daily
storm series, or independently bias-corrected sub-daily rainfall. Intervals carry
forward daily uncertainty but do not quantify scaling or transfer uncertainty.
R² near 1 follows from the imposed power law and is not independent validation.
The existing 250-/500-year warnings still apply.

**Custom exponent** is a separate user-selected method with 5–1440-minute
scaling; sub-hour values and custom exponents are not claimed as supported by
this Pakistan study. Turning scaling off retains only 24-hour results.

## Verification

- Full-text Eq. (1), its units and durations manually checked.
- Numerical checks against cube-root reference calculations at 1 and 4 hours.
- Original 24-hour result and uncertainty preserved.
- Power-equation exponent −2/3 recovered; 30-minute calculator input rejected.
- Custom and published duration ranges remain distinct.
- Both intensity units retain the exact 25.4 mm/inch conversion.
