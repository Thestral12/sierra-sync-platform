'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { useRealtimeSync } from '@/hooks/useRealtimeSync'
import { useSyncMetrics } from '@/hooks/useSyncMetrics'
import { 
  Activity, 
  Users, 
  Zap, 
  AlertCircle, 
  CheckCircle2, 
  Clock,
  TrendingUp,
  RefreshCw,
  Settings,
  Plus
} from 'lucide-react'
import { LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

export default function DashboardPage() {
  const { syncStatus, recentSyncs, activeSyncs } = useRealtimeSync()
  const { metrics, loading } = useSyncMetrics()
  const [refreshing, setRefreshing] = useState(false)

  const handleManualSync = async () => {
    setRefreshing(true)
    // Trigger manual sync
    await fetch('/api/sync/trigger', { method: 'POST' })
    setTimeout(() => setRefreshing(false), 2000)
  }

  const syncData = [
    { time: '00:00', successful: 120, failed: 5 },
    { time: '04:00', successful: 80, failed: 2 },
    { time: '08:00', successful: 200, failed: 8 },
    { time: '12:00', successful: 350, failed: 12 },
    { time: '16:00', successful: 280, failed: 7 },
    { time: '20:00', successful: 150, failed: 3 },
    { time: '23:59', successful: 90, failed: 1 },
  ]

  const leadFlowData = [
    { day: 'Mon', leads: 45 },
    { day: 'Tue', leads: 52 },
    { day: 'Wed', leads: 38 },
    { day: 'Thu', leads: 65 },
    { day: 'Fri', leads: 72 },
    { day: 'Sat', leads: 43 },
    { day: 'Sun', leads: 36 },
  ]

  return (
    <div className="flex-1 space-y-4 p-8 pt-6">
      <div className="flex items-center justify-between space-y-2">
        <h2 className="text-3xl font-bold tracking-tight">Dashboard</h2>
        <div className="flex items-center space-x-2">
          <Button variant="outline" size="sm" onClick={handleManualSync}>
            <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            Manual Sync
          </Button>
          <Button size="sm">
            <Plus className="mr-2 h-4 w-4" />
            Add Integration
          </Button>
        </div>
      </div>

      {/* Metrics Overview */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Leads Synced</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{metrics?.totalLeads || '2,543'}</div>
            <p className="text-xs text-muted-foreground">
              <TrendingUp className="inline h-3 w-3 text-green-500" /> +12.5% from last week
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Integrations</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{metrics?.activeIntegrations || 4}</div>
            <div className="flex gap-1 mt-2">
              <Badge variant="secondary" className="text-xs">HubSpot</Badge>
              <Badge variant="secondary" className="text-xs">Salesforce</Badge>
              <Badge variant="secondary" className="text-xs">Zoho</Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Sync Success Rate</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">98.7%</div>
            <Progress value={98.7} className="mt-2" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg Sync Time</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">1.2s</div>
            <p className="text-xs text-muted-foreground">
              <TrendingUp className="inline h-3 w-3 text-green-500" /> 15% faster than yesterday
            </p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="syncs">Recent Syncs</TabsTrigger>
          <TabsTrigger value="errors">Errors</TabsTrigger>
          <TabsTrigger value="workflows">Workflows</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
            <Card className="col-span-4">
              <CardHeader>
                <CardTitle>Sync Activity</CardTitle>
                <CardDescription>
                  Successful vs Failed syncs over the last 24 hours
                </CardDescription>
              </CardHeader>
              <CardContent className="pl-2">
                <ResponsiveContainer width="100%" height={350}>
                  <AreaChart data={syncData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" />
                    <YAxis />
                    <Tooltip />
                    <Area 
                      type="monotone" 
                      dataKey="successful" 
                      stackId="1"
                      stroke="#10b981" 
                      fill="#10b981" 
                      fillOpacity={0.6}
                    />
                    <Area 
                      type="monotone" 
                      dataKey="failed" 
                      stackId="1"
                      stroke="#ef4444" 
                      fill="#ef4444"
                      fillOpacity={0.6}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card className="col-span-3">
              <CardHeader>
                <CardTitle>Lead Flow</CardTitle>
                <CardDescription>
                  New leads captured this week
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={350}>
                  <BarChart data={leadFlowData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="day" />
                    <YAxis />
                    <Tooltip />
                    <Bar dataKey="leads" fill="#3b82f6" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>

          {/* Real-time Activity Feed */}
          <Card>
            <CardHeader>
              <CardTitle>Real-time Activity</CardTitle>
              <CardDescription>
                Live feed of sync operations
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {activeSyncs.map((sync, index) => (
                  <div key={index} className="flex items-center justify-between">
                    <div className="flex items-center space-x-4">
                      <div className={`p-2 rounded-full ${
                        sync.status === 'completed' ? 'bg-green-100' : 
                        sync.status === 'failed' ? 'bg-red-100' : 'bg-yellow-100'
                      }`}>
                        {sync.status === 'completed' ? (
                          <CheckCircle2 className="h-4 w-4 text-green-600" />
                        ) : sync.status === 'failed' ? (
                          <AlertCircle className="h-4 w-4 text-red-600" />
                        ) : (
                          <Activity className="h-4 w-4 text-yellow-600 animate-pulse" />
                        )}
                      </div>
                      <div>
                        <p className="text-sm font-medium">
                          {sync.leadName} → {sync.crmName}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {sync.timestamp}
                        </p>
                      </div>
                    </div>
                    <Badge variant={
                      sync.status === 'completed' ? 'default' : 
                      sync.status === 'failed' ? 'destructive' : 'secondary'
                    }>
                      {sync.status}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="syncs" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Recent Sync History</CardTitle>
              <CardDescription>
                Detailed log of all sync operations
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {recentSyncs.map((sync, index) => (
                  <div key={index} className="flex items-center justify-between p-4 border rounded-lg">
                    <div className="flex items-center space-x-4">
                      <Badge variant={sync.direction === 'inbound' ? 'outline' : 'default'}>
                        {sync.direction}
                      </Badge>
                      <div>
                        <p className="font-medium">{sync.entityType}: {sync.entityName}</p>
                        <p className="text-sm text-muted-foreground">
                          {sync.source} → {sync.destination}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-sm text-muted-foreground">{sync.duration}ms</span>
                      <Badge variant={sync.success ? 'default' : 'destructive'}>
                        {sync.success ? 'Success' : 'Failed'}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="errors" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Error Log</CardTitle>
              <CardDescription>
                Recent sync errors and failures
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="p-4 border border-red-200 rounded-lg bg-red-50">
                  <div className="flex items-start space-x-3">
                    <AlertCircle className="h-5 w-5 text-red-600 mt-0.5" />
                    <div className="flex-1">
                      <p className="font-medium text-red-900">
                        HubSpot API Rate Limit Exceeded
                      </p>
                      <p className="text-sm text-red-700 mt-1">
                        Failed to sync 3 leads due to rate limiting. Retry scheduled in 5 minutes.
                      </p>
                      <p className="text-xs text-red-600 mt-2">
                        2 minutes ago • Error Code: 429
                      </p>
                    </div>
                    <Button size="sm" variant="outline">
                      Retry Now
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="workflows" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Active Workflows</CardTitle>
              <CardDescription>
                Manage your automation workflows
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 border rounded-lg">
                  <div className="flex items-center space-x-4">
                    <div className="p-2 bg-blue-100 rounded-lg">
                      <Zap className="h-4 w-4 text-blue-600" />
                    </div>
                    <div>
                      <p className="font-medium">Lead Assignment Workflow</p>
                      <p className="text-sm text-muted-foreground">
                        Auto-assign leads based on geography and score
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Badge variant="default">Active</Badge>
                    <Button size="sm" variant="ghost">
                      <Settings className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="flex items-center justify-between p-4 border rounded-lg">
                  <div className="flex items-center space-x-4">
                    <div className="p-2 bg-green-100 rounded-lg">
                      <Users className="h-4 w-4 text-green-600" />
                    </div>
                    <div>
                      <p className="font-medium">High-Value Lead Alert</p>
                      <p className="text-sm text-muted-foreground">
                        Notify sales team for leads with score > 80
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Badge variant="default">Active</Badge>
                    <Button size="sm" variant="ghost">
                      <Settings className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}