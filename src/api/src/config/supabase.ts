import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY

if (!supabaseUrl) {
  throw new Error('SUPABASE_URL environment variable is not set')
}

if (!supabaseServiceKey) {
  throw new Error('SUPABASE_SERVICE_KEY environment variable is not set')
}

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    persistSession: false
  },
  global: {
    headers: {
      'x-application-name': 'sierra-sync-api'
    }
  }
})

export default supabase
