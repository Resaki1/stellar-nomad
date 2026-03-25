# Localization Feature

We need a system to show the player the locations of various points of interest (POIs) in the game world, such as planets, asteroid fields, and other ships. This "localization" feature should provide a clear and intuitive way for players to understand where these POIs are relative to their current position and orientation. For now, we can focus on the single asteroid field defined in `src/sim/systems/sol.json` as a test case.

- When the POI is in the player's field of view, show a marker at the correct screen position. The marker's size should always have the same apparent size (e.g. 32px diameter) regardless of distance.
- The marker should show the distance to the POI in kilometers, rounded to the nearest 1km (e.g. "123km").
- The POI can be focussed, similar to asteroids. When focussed, the name of the POI (e.g. "Asteroid Field") should be shown above the distance. Focus is lost as soon as the player looks away from the POI.
- When the POI is outside the player's field of view, show an arrow at the edge of the screen pointing in the direction of the POI. The arrow should not show the distance to the POI.