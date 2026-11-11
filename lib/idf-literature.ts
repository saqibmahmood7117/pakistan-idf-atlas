/** Published support for the equation family, not for a site's fitted coefficients. */
export const IDF_LITERATURE = [
  {
    label: "Gutiérrez-López, Jiménez Hernández & Sandoval (2019), Water",
    title: "Physical Parameterization of IDF Curves Based on Short-Duration Storms",
    url: "https://consensus.app/papers/physical-parameterization-of-idf-curves-based-on-gutierrez-lopez-hernández/722a1c3dd9655139bc043525013770e9/?utm_source=chatgpt",
    finding: "Supports numerical calibration of the Sherman family and discusses the physical interpretation of its additive duration parameter using short-duration storm observations.",
  },
  {
    label: "Zeri, Hamed, Wang & Shahid (2023), Water",
    title: "Utilizing Satellite Data to Establish Rainfall Intensity-Duration-Frequency Curves for Major Cities in Iraq",
    url: "https://consensus.app/papers/utilizing-satellite-data-to-establish-rainfall-zeri-hamed/d56ff8d5b9bc5b7b91547a0ec19d9c74/?utm_source=chatgpt",
    finding: "Uses Sherman relationships after extreme-value analysis and emphasizes gauge correction of satellite-derived rainfall estimates.",
  },
  {
    label: "Gutiérrez-López & Ramírez (2025), AppliedMath",
    title: "Mathematical Formulation of Intensity–Duration–Frequency Curves and Their Hydrological Risk Implications in Civil Engineering Design",
    url: "https://consensus.app/papers/mathematical-formulation-of-gutierrez-lopez-ramirez/e5d307a3befe53ea80df9474d31351e2/?utm_source=chatgpt",
    finding: "Identifies the zero-duration divergence of formulations without an additive duration parameter and proposes an alternative calibrated formulation. The Atlas does not claim to implement that paper’s IDF-GtzLo algorithm.",
  },
] as const;
