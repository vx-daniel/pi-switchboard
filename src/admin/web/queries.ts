/**
 * The reads every part of the admin UI shares (#367): one query per API route, kept current as
 * the console keeps its views (the requests over their stream, the status every few seconds), so
 * the shell's strip and sidebar and the pages read the same data.
 *
 * @packageDocumentation
 */

import {
  type Account,
  AccountsSchema,
  checked,
  type Doctor,
  DoctorSchema,
  readApi,
  type Requests,
  RequestsSchema,
  type StatsWindow,
  type Status,
  StatusSchema
} from '@proxy/admin/web/api'
import { type UseQueryResult, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

/** The requests query's key: the stream writes its snapshots here. */
const REQUESTS_KEY = ['requests'] as const
/** How often the status is read, in milliseconds, as the console reads its status. */
const STATUS_MS = 5000
/** How often the logins are read, in milliseconds: quotas change with each request. */
const ACCOUNTS_MS = 10_000
/** How often the doctor's report is read, in milliseconds. */
const DOCTOR_MS = 30_000
/** How often the clock moves on, in milliseconds, for elapsed times and times left. */
const CLOCK_MS = 1000

/**
 * Reads the requests, then follows `/admin/api/requests/stream`, which sends them again on each
 * change. Call it once, in the shell; the pages read the same query.
 *
 * @returns the requests query
 */
export function useFollowedRequests(): UseQueryResult<Requests> {
  const queryClient = useQueryClient()
  useEffect(() => {
    const source = new EventSource('/admin/api/requests/stream')
    const onRequests = (message: MessageEvent<string>): void => {
      const snapshot = checked(RequestsSchema, JSON.parse(message.data), '/requests/stream')
      queryClient.setQueryData(REQUESTS_KEY, snapshot)
    }
    source.addEventListener('requests', onRequests)
    return () => {
      source.removeEventListener('requests', onRequests)
      source.close()
    }
  }, [queryClient])
  return useRequests()
}

/**
 * Reads the requests, as the stream last sent them.
 *
 * @returns the requests query
 */
export function useRequests(): UseQueryResult<Requests> {
  return useQuery({ queryKey: REQUESTS_KEY, queryFn: () => readApi('/requests', RequestsSchema) })
}

/**
 * Reads the proxy's status every few seconds.
 *
 * @returns the status query
 */
export function useStatus(): UseQueryResult<Status> {
  return useQuery({
    queryKey: ['status'],
    queryFn: () => readApi('/status', StatusSchema),
    refetchInterval: STATUS_MS
  })
}

/**
 * Reads the logins every few seconds.
 *
 * @returns the accounts query
 */
export function useAccounts(): UseQueryResult<Account[]> {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: () => readApi('/accounts', AccountsSchema),
    refetchInterval: ACCOUNTS_MS
  })
}

/**
 * Reads the doctor's report over a window, again every half minute.
 *
 * @param statsWindow - the window
 * @returns the doctor query
 */
export function useDoctor(statsWindow: StatsWindow): UseQueryResult<Doctor> {
  return useQuery({
    queryKey: ['doctor', statsWindow],
    queryFn: () => readApi(`/doctor?window=${statsWindow}`, DoctorSchema),
    refetchInterval: DOCTOR_MS
  })
}

/**
 * Follows the time, a second at a time, for elapsed times and times left.
 *
 * @returns the time now, in milliseconds since the epoch
 */
export function useNow(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
    }, CLOCK_MS)
    return () => {
      clearInterval(timer)
    }
  }, [])
  return now
}
