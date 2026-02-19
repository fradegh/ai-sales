import { Switch, Route, useLocation } from "wouter";
import { useEffect } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/lib/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Bot, MessageSquare, Brain, Shield } from "lucide-react";
import { wsClient } from "@/lib/websocket";
import Dashboard from "@/pages/dashboard";
import Conversations from "@/pages/conversations";
import KnowledgeBase from "@/pages/knowledge-base";
import Products from "@/pages/products";
import Escalations from "@/pages/escalations";
import Settings from "@/pages/settings";
import CustomerProfile from "@/pages/customer-profile";
import Onboarding from "@/pages/onboarding";
import Analytics from "@/pages/analytics";
import SecurityStatus from "@/pages/security-status";
import Billing from "@/pages/billing";
import AdminSecrets from "@/pages/admin-secrets";
import AdminUsers from "@/pages/admin-users";
import AdminBilling from "@/pages/admin-billing";
import AdminProxies from "@/pages/admin-proxies";
import NotFound from "@/pages/not-found";
import OwnerLoginPage from "@/pages/owner-login";
import OwnerDashboard from "@/pages/owner-dashboard";
import OwnerUpdates from "@/pages/owner-updates";
import { 
  LoginPage, 
  SignupPage, 
  VerifyEmailPage, 
  ForgotPasswordPage, 
  ResetPasswordPage 
} from "@/pages/auth";

function AdminGuard({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const [, navigate] = useLocation();
  
  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }
  
  if (!user?.isPlatformAdmin && !user?.isPlatformOwner) {
    navigate("/");
    return null;
  }
  
  return <>{children}</>;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/conversations" component={Conversations} />
      <Route path="/customers/:id" component={CustomerProfile} />
      <Route path="/knowledge-base" component={KnowledgeBase} />
      <Route path="/products" component={Products} />
      <Route path="/escalations" component={Escalations} />
      <Route path="/settings" component={Settings} />
      <Route path="/onboarding" component={Onboarding} />
      <Route path="/analytics" component={Analytics} />
      <Route path="/admin/security">
        {() => <AdminGuard><SecurityStatus /></AdminGuard>}
      </Route>
      <Route path="/admin/billing">
        {() => <AdminGuard><AdminBilling /></AdminGuard>}
      </Route>
      <Route path="/admin/secrets">
        {() => <AdminGuard><AdminSecrets /></AdminGuard>}
      </Route>
      <Route path="/admin/users">
        {() => <AdminGuard><AdminUsers /></AdminGuard>}
      </Route>
      <Route path="/admin/proxies">
        {() => <AdminGuard><AdminProxies /></AdminGuard>}
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto flex h-16 items-center justify-between gap-4 px-4">
          <div className="flex items-center gap-2">
            <Bot className="h-6 w-6 text-primary" />
            <span className="text-lg font-semibold">AI Sales Operator</span>
          </div>
          <div className="flex items-center gap-4">
            <ThemeToggle />
            <Button variant="outline" asChild data-testid="button-login-email">
              <a href="/login">Войти</a>
            </Button>
            <Button asChild data-testid="button-signup">
              <a href="/signup">Регистрация</a>
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-16">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Автоматизация продаж с ИИ
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            Умный оператор для обработки клиентских обращений через Telegram, WhatsApp и другие мессенджеры. 
            ИИ генерирует ответы, а вы контролируете качество.
          </p>
          <div className="mt-10">
            <Button size="lg" asChild data-testid="button-get-started">
              <a href="/signup">Начать работу</a>
            </Button>
          </div>
        </div>

        <div className="mx-auto mt-20 grid max-w-4xl gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <MessageSquare className="h-8 w-8 text-primary" />
              <CardTitle className="mt-4">Мультиканальность</CardTitle>
            </CardHeader>
            <CardContent>
              <CardDescription>
                Поддержка Telegram, WhatsApp, MAX и других мессенджеров в едином интерфейсе
              </CardDescription>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <Brain className="h-8 w-8 text-primary" />
              <CardTitle className="mt-4">ИИ-подсказки</CardTitle>
            </CardHeader>
            <CardContent>
              <CardDescription>
                Автоматическая генерация ответов на основе базы знаний и каталога товаров
              </CardDescription>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <Shield className="h-8 w-8 text-primary" />
              <CardTitle className="mt-4">Контроль качества</CardTitle>
            </CardHeader>
            <CardContent>
              <CardDescription>
                Одобряйте, редактируйте или отклоняйте ответы ИИ перед отправкой клиенту
              </CardDescription>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}

interface OnboardingState {
  status: "NOT_STARTED" | "IN_PROGRESS" | "DONE";
  currentStep: string;
}

function AuthenticatedApp() {
  const { user, logout, isLoggingOut } = useAuth();
  const [location, setLocation] = useLocation();
  
  const { data: onboardingState, isLoading: onboardingLoading } = useQuery<OnboardingState>({
    queryKey: ["/api/onboarding/state"],
  });

  useEffect(() => {
    wsClient.connect();
    return () => {
      wsClient.disconnect();
    };
  }, []);
  
  useEffect(() => {
    if (!onboardingLoading && onboardingState) {
      const needsOnboarding = onboardingState.status === "NOT_STARTED" || onboardingState.status === "IN_PROGRESS";
      const isOnOnboardingPage = location === "/onboarding";
      
      if (needsOnboarding && !isOnOnboardingPage) {
        setLocation("/onboarding");
      }
    }
  }, [onboardingState, onboardingLoading, location, setLocation]);

  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  return (
    <SidebarProvider style={style as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b px-4">
            <SidebarTrigger data-testid="button-sidebar-toggle" />
            <div className="flex items-center gap-4">
              <span className="text-sm text-muted-foreground">
                {user?.email || user?.firstName || "Пользователь"}
              </span>
              <ThemeToggle />
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => logout()}
                disabled={isLoggingOut}
                data-testid="button-logout"
              >
                {isLoggingOut ? <Loader2 className="h-4 w-4 animate-spin" /> : "Выйти"}
              </Button>
            </div>
          </header>
          <main className="flex-1 overflow-auto">
            <Router />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

function AuthRouter() {
  return (
    <Switch>
      <Route path="/login" component={LoginPage} />
      <Route path="/signup" component={SignupPage} />
      <Route path="/verify-email" component={VerifyEmailPage} />
      <Route path="/forgot-password" component={ForgotPasswordPage} />
      <Route path="/reset-password" component={ResetPasswordPage} />
      <Route component={LandingPage} />
    </Switch>
  );
}

function OwnerRouter() {
  return (
    <Switch>
      <Route path="/owner/login" component={OwnerLoginPage} />
      <Route path="/owner/updates" component={OwnerUpdates} />
      <Route path="/owner" component={OwnerDashboard} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  const [location] = useLocation();
  const { isLoading, isAuthenticated } = useAuth();
  
  const authRoutes = ["/login", "/signup", "/verify-email", "/forgot-password", "/reset-password"];
  const isAuthRoute = authRoutes.some(route => location.startsWith(route));
  const isOwnerRoute = location.startsWith("/owner");

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (isOwnerRoute) {
    return <OwnerRouter />;
  }

  if (isAuthRoute) {
    return <AuthRouter />;
  }

  if (!isAuthenticated) {
    return <LandingPage />;
  }

  return <AuthenticatedApp />;
}

function AppWrapper() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light" storageKey="ai-sales-operator-theme">
        <TooltipProvider>
          <App />
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default AppWrapper;
