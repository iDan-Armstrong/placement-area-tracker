/* Settings for the SNND Manager. Nothing here is secret: the client ID only identifies the app,
   and every person still signs in with their own ArcGIS Online account. */
window.TRACKER_CONFIG = {
  org: "Sabine-Neches Navigation District",
  title: "SNND Manager",
  portal: "https://snnd.maps.arcgis.com",
  clientId: "FXWMHiWVe99CqSRL",

  // Placement areas and the entry log this page reads and writes.
  areasUrl: "https://services.arcgis.com/AfLVH0NU5WH2COCi/arcgis/rest/services/PA_Boundaries_TEST/FeatureServer/0",
  logUrl: "https://services.arcgis.com/AfLVH0NU5WH2COCi/arcgis/rest/services/PA_Placement_Log_TEST/FeatureServer/0",
  testMode: true,

  // Map page: the two web maps to combine, and the layers the two modes act on.
  opsMapId: "1970236a98bb44daacbc26fc57b0bf13",
  reMapId: "be2e44a1e6e542308f136c7c12b202f9",
  mapAreasUrl: "https://services.arcgis.com/AfLVH0NU5WH2COCi/arcgis/rest/services/PA_Boundaries/FeatureServer/6",
  tractsUrl: "https://services.arcgis.com/AfLVH0NU5WH2COCi/arcgis/rest/services/Real_Estate_Tracts/FeatureServer/34",
  sdk: "4.31",

  // Who may add and remove attached files. Viewing is always on.
  files: { areas: true, tracts: false },

  units: "cubic yards",
  greenAtOrAbove: 66,
  redBelow: 33,

  logos: { org: "assets/snnd-logo.png", dev: "assets/awc-logo.png" },
  developer: { company: "Arceneaux Wilson & Cole", author: "Dan Armstrong" }
};
