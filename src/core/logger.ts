export const isDebug = process.env.DEBUG === '1'

export function debug(...args: any[]) {
	if (!isDebug) return
	console.log(...args)
}

export function info(...args: any[]) {
	console.log(...args)
}

export function error(...args: any[]) {
	console.error(...args)
}


