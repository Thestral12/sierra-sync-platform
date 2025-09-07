'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CheckCircle2, Zap, Shield, BarChart3, Users, Workflow } from 'lucide-react'

export default function HomePage() {
  const { user, loading } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (!loading && user) {
      router.push('/dashboard')
    }
  }, [user, loading, router])

  const features = [
    {
      icon: <Zap className="h-6 w-6" />,
      title: 'Real-time Sync',
      description: 'Instant lead synchronization between Sierra Interactive and your CRMs'
    },
    {
      icon: <Users className="h-6 w-6" />,
      title: 'Multi-CRM Support',
      description: 'Connect HubSpot, Salesforce, Zoho, and more simultaneously'
    },
    {
      icon: <Workflow className="h-6 w-6" />,
      title: 'Custom Workflows',
      description: 'Build automated lead routing and follow-up sequences'
    },
    {
      icon: <Shield className="h-6 w-6" />,
      title: 'Secure & Compliant',
      description: 'Enterprise-grade security with OAuth 2.0 and encrypted data'
    },
    {
      icon: <BarChart3 className="h-6 w-6" />,
      title: 'Analytics Dashboard',
      description: 'Monitor sync performance and lead flow metrics in real-time'
    },
    {
      icon: <CheckCircle2 className="h-6 w-6" />,
      title: 'Error Recovery',
      description: 'Automatic retry logic and comprehensive error handling'
    }
  ]

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      <header className="container mx-auto px-4 py-6">
        <nav className="flex justify-between items-center">
          <div className="flex items-center space-x-2">
            <Zap className="h-8 w-8 text-blue-600" />
            <span className="text-2xl font-bold">Sierra Sync</span>
          </div>
          <div className="flex gap-4">
            <Button variant="outline" onClick={() => router.push('/login')}>
              Sign In
            </Button>
            <Button onClick={() => router.push('/signup')}>
              Get Started
            </Button>
          </div>
        </nav>
      </header>

      <main className="container mx-auto px-4 py-16">
        <section className="text-center mb-16">
          <h1 className="text-5xl font-bold mb-6">
            Automate Your Real Estate Lead Management
          </h1>
          <p className="text-xl text-gray-600 mb-8 max-w-3xl mx-auto">
            Seamlessly sync leads between Sierra Interactive and your favorite CRMs. 
            Save hours of manual data entry and never miss a hot lead again.
          </p>
          <div className="flex gap-4 justify-center">
            <Button size="lg" onClick={() => router.push('/signup')}>
              Start Free Trial
            </Button>
            <Button size="lg" variant="outline" onClick={() => router.push('/demo')}>
              Watch Demo
            </Button>
          </div>
        </section>

        <section className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-16">
          {features.map((feature, index) => (
            <Card key={index}>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-blue-100 rounded-lg text-blue-600">
                    {feature.icon}
                  </div>
                  <CardTitle className="text-lg">{feature.title}</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <CardDescription>{feature.description}</CardDescription>
              </CardContent>
            </Card>
          ))}
        </section>

        <section className="bg-blue-50 rounded-2xl p-12 text-center">
          <h2 className="text-3xl font-bold mb-4">
            Trusted by 500+ Real Estate Teams
          </h2>
          <p className="text-lg text-gray-600 mb-8">
            Join successful real estate professionals who've automated their lead management
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-8">
            <div>
              <div className="text-3xl font-bold text-blue-600">10M+</div>
              <div className="text-gray-600">Leads Synced</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-blue-600">99.9%</div>
              <div className="text-gray-600">Uptime</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-blue-600">5min</div>
              <div className="text-gray-600">Setup Time</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-blue-600">24/7</div>
              <div className="text-gray-600">Support</div>
            </div>
          </div>
          <Button size="lg" onClick={() => router.push('/signup')}>
            Start Your Free Trial
          </Button>
        </section>
      </main>

      <footer className="container mx-auto px-4 py-8 mt-16 border-t">
        <div className="flex justify-between items-center">
          <div className="text-gray-600">
            © 2024 Sierra Sync. All rights reserved.
          </div>
          <div className="flex gap-6">
            <a href="/privacy" className="text-gray-600 hover:text-gray-900">Privacy</a>
            <a href="/terms" className="text-gray-600 hover:text-gray-900">Terms</a>
            <a href="/docs" className="text-gray-600 hover:text-gray-900">Documentation</a>
            <a href="/support" className="text-gray-600 hover:text-gray-900">Support</a>
          </div>
        </div>
      </footer>
    </div>
  )
}