// Версии JSON API службы Опорной станции (APP-23; research R10).

/** Версии API, которые поддерживает эта программа. */
export const API_VERSIONS: readonly number[] = [1];

/** Заголовок, в котором каждая сторона называет свою версию API. */
export const API_VERSION_HEADER = "aristotel-api-version";

/** Заголовок с Идентификатором Члена Группы — автора действия. */
export const MEMBER_HEADER = "aristotel-member";

/** Порт службы на loopback по умолчанию. */
export const DEFAULT_PORT = 47100;
/** Порт интерфейса локальной части Станции на 127.0.0.1 по умолчанию (research R14 фичи 004). */
export const STATION_DEFAULT_PORT = 47321;

/** Версия программы; одна на все роли (APP-01). */
export const PROGRAM_VERSION = "0.1.0";

export function isSupportedApiVersion(value: string | undefined): boolean {
  return value !== undefined && /^\d+$/.test(value) && API_VERSIONS.includes(Number(value));
}
