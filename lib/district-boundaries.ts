export const OCHA_ADM2_CATALOGUE_COUNT = 160;

const BOUNDARY_NAME_ALIASES: Record<string, string> = {
  upperchitral: "chitralupper",
  lowerchitral: "chitrallower",
  upperkohistan: "kohistanupper",
  lowerkohistan: "kohistanlower",
  battagram: "batagram",
  kolaipallaskohistan: "kolaipalaskohistan",
  deraismailkhan: "dikhan",
  hattianbala: "jhelumvalley",
  diamer: "diamir",
  layyah: "leiah",
  karachicentral: "centralkarachi",
  karachieast: "eastkarachi",
  karachisouth: "southkarachi",
  karachiwest: "westkarachi",
  malir: "malirkarachi",
  korangi: "korangikarachi",
  surab: "shaheedsikandarabad",
  sheikhupura: "sheikhpura",
  killaabdullah: "qillaabdullah",
  killasaifullah: "qillasaifullah",
  islamabad: "islamabadcapitalterritory",
  naushahroferoze: "naushehroferoze",
  kambarshahdadkot: "qambarshahdadkot",
  kachhibolan: "kachhi",
};

export function normalizeBoundaryName(value: string) {
  const key = value
    .toLowerCase()
    .replace(/\bdistrict\b|\bdivision\b/g, "")
    .replace(/[^a-z0-9]/g, "");
  return BOUNDARY_NAME_ALIASES[key] ?? key;
}

export function boundaryFeatureName(properties: Record<string, unknown>) {
  return String(
    properties.ADM2_EN ??
      properties.adm2_name ??
      properties.shapeName ??
      properties.NAME_2 ??
      properties.DISTRICT ??
      "Unnamed",
  );
}
