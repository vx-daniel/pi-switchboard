/**
 * Helpers for async iterators.
 *
 * @packageDocumentation
 */

/**
 * Joins the first result of an event iterator and the rest of it into one async iterable.
 *
 * @remarks
 * Ending it early (the client left mid-stream) ends the rest too.
 *
 * @typeParam T - the event type
 * @param first - the result already read from `rest`
 * @param rest - the iterator `first` came from
 * @returns a generator that yields `first`'s value (unless it is done), then the rest
 */
export async function* startingWith<T>(
  first: IteratorResult<T>,
  rest: AsyncIterator<T>
): AsyncGenerator<T> {
  try {
    if (first.done === true) return
    yield first.value
    for (let next = await rest.next(); next.done !== true; next = await rest.next()) {
      yield next.value
    }
  } finally {
    await rest.return?.()
  }
}
