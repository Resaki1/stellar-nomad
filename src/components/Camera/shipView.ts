import { Vector3 } from "three";

/**
 * The rendered ship's nose ray in local scene space (metres, floating origin), written by the
 * ship every frame before priority-0 frame hooks. Targeting aims along this, never the camera:
 * the chase camera lags, so screen centre is not the nose.
 */
export const shipView = {
  position: new Vector3(),
  forward: new Vector3(0, 0, 1),
};
