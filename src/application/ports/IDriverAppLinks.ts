/** Which user is a driver's app login (drivers.user_id; tenant unit of work). */
export interface IDriverAppLinks {
  driverOf(userId: string): Promise<string | null>;
  userOf(driverId: string): Promise<string | null>;
  link(driverId: string, userId: string): Promise<void>;
}
