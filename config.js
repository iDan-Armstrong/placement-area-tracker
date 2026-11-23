// Settings for this deployment. Nothing here is secret: the client ID only
// identifies the app, and the layers still require a signed-in account.
window.TRACKER_CONFIG = {
  portal: "https://snnd.maps.arcgis.com",
  clientId: "FXWMHiWVe99CqSRL",
  // TEST copies. Point these at the production layer and log when ready.
  areasUrl: "https://services.arcgis.com/AfLVH0NU5WH2COCi/arcgis/rest/services/PA_Boundaries_TEST/FeatureServer/0",
  logUrl: "https://services.arcgis.com/AfLVH0NU5WH2COCi/arcgis/rest/services/PA_Placement_Log_TEST/FeatureServer/0",
  testMode: true,
  title: "Placement Area Tracker",
  units: "cubic yards",
  greenAtOrAbove: 66, // percent of capacity still available
  redBelow: 33
};
