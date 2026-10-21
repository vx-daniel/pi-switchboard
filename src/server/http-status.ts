/**
 * HTTP status codes used by the proxy's routes and middleware.
 *
 * @packageDocumentation
 */

/** HTTP 200 OK, the first success status. */
export const HTTP_OK = 200

/** The first status that is not a success (2xx). */
export const HTTP_MULTIPLE_CHOICES = 300

/** HTTP 400 Bad Request. */
export const HTTP_BAD_REQUEST = 400
/** HTTP 401 Unauthorized. */
export const HTTP_UNAUTHORIZED = 401
/** HTTP 404 Not Found. */
export const HTTP_NOT_FOUND = 404
/** HTTP 413 Payload Too Large. */
export const HTTP_PAYLOAD_TOO_LARGE = 413
/** HTTP 422 Unprocessable Entity. */
export const HTTP_UNPROCESSABLE_ENTITY = 422
/** HTTP 429 Too Many Requests. */
export const HTTP_TOO_MANY_REQUESTS = 429
/** HTTP 500 Internal Server Error. */
export const HTTP_INTERNAL_SERVER_ERROR = 500
/** HTTP 502 Bad Gateway. */
export const HTTP_BAD_GATEWAY = 502
/** HTTP 503 Service Unavailable. */
export const HTTP_SERVICE_UNAVAILABLE = 503
/** HTTP 504 Gateway Timeout. */
export const HTTP_GATEWAY_TIMEOUT = 504
