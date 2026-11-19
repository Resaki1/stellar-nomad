import type { PilotContactMsg } from "@/sim/session/protocol";
import type { ShipState } from "@/sim/ship/shipState";
import { PILOT_CONTACT_MAX_KMPS } from "@/sim/session/pilotContact";

const MAX_PENDING = 8;
const MAX_AGE_MS = 240;
const MAX_DISTANCE_KM = 0.028;
const queue: PilotContactMsg[] = [];
let generation = -1;
let lastId = 0;

export function clearPilotContacts(): void {
  queue.length = 0;
}

export function receivePilotContact(message: PilotContactMsg): void {
  if (message.gen !== generation) {
    generation = message.gen;
    lastId = 0;
    clearPilotContacts();
  }
  if (message.id <= lastId) return;
  lastId = message.id;
  if (queue.length < MAX_PENDING) queue.push(message);
}

export function drainPilotContacts(ship: ShipState, motion: number, now: number, apply: (contact: PilotContactMsg) => void): void {
  if (ship.velKmps.length() <= PILOT_CONTACT_MAX_KMPS) {
    for (const msg of queue) {
      const { contact, tick } = msg;
      const p = ship.posKm, point = contact.positionKm;
      if (msg.motion === motion && contact.frameId === ship.frameId && now >= tick && now - tick <= MAX_AGE_MS &&
        Math.hypot(p.x - point[0], p.y - point[1], p.z - point[2]) <= MAX_DISTANCE_KM) apply(msg);
    }
  }
  clearPilotContacts();
}

export function resetPilotContactInbox(): void {
  generation = -1;
  lastId = 0;
  clearPilotContacts();
}
